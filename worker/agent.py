"""yue GPU agent: prepares the box, runs YuE2-Turbo, pulls cover jobs from
DynamoDB, publishes results to S3 and powers the instance off when idle.

Runs as root under systemd (yue-agent.service). Uses only system python3 +
python3-boto3 + python3-requests so it works before the ML venv exists.
"""
import json
import os
from decimal import Decimal
import subprocess
import threading
import time
import traceback
import uuid
from pathlib import Path

import boto3
import requests
from boto3.dynamodb.conditions import Key

REGION = os.environ["YUE_REGION"]
BUCKET = os.environ["YUE_BUCKET"]
TABLE = os.environ["YUE_TABLE"]
IDLE_MINUTES = int(os.environ.get("YUE_IDLE_MINUTES", "10"))
APP = Path("/opt/yue/app")
WORK = Path("/opt/yue/work")
TURBO = "http://127.0.0.1:8000"
WORKER_ID = "__worker__"
MAX_PARALLEL = 2          # matches YUE2_AR_CONCURRENCY in turbo.env
MAX_ATTEMPTS = 2
TASKS = "tasks"           # owner of non-cover queue items (e.g. stem separation)
SEPARATOR = "/opt/yue/sep/.venv/bin/audio-separator"
SEPARATOR_MODELS = "/opt/yue/sep/models"
SEPARATOR_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"   # keep in sync with setup-separator.sh
SEPARATOR_TIMEOUT = 10 * 60   # a 3 min song takes ~3 min on the L4; anything far beyond that is stuck

table = boto3.resource("dynamodb", region_name=REGION).Table(TABLE)
s3 = boto3.client("s3", region_name=REGION)

BOOT_STARTED = time.monotonic()
state_lock = threading.Lock()
state = {"state": "booting", "message": "Açılıyor"}
active = {}               # job id -> thread
last_activity = time.time()
turbo_up = False          # YuE2 holds ~21 GB of the GPU; it is stopped while a separation runs
stop_requested = False    # a finished cover asked for "stop the GPU when done" (waits for its stems and the queue)
STOP_GRACE = 30           # seconds of quiet before that stop, so a just-queued stems task shows up in the queue index


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def now():
    return int(time.time())


def touch():
    global last_activity
    last_activity = time.time()


def imds(path):
    token = requests.put("http://169.254.169.254/latest/api/token",
                         headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"}, timeout=2).text
    return requests.get(f"http://169.254.169.254/latest/meta-data/{path}",
                        headers={"X-aws-ec2-metadata-token": token}, timeout=2).text


def set_state(name, message):
    with state_lock:
        state.update(state=name, message=message)
    log(f"[{name}] {message}")
    heartbeat()


def heartbeat():
    with state_lock:
        fields = dict(state)
    busy = bool(active) or fields["state"] in ("setup", "loading")
    if busy:
        touch()
    fields.update(heartbeat_at=now(), last_activity_at=int(last_activity), active_jobs=len(active))
    try:
        fields["instance_type"] = imds("instance-type")
    except Exception:
        pass
    try:
        table.update_item(Key={"id": WORKER_ID},
                          UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in fields),
                          ExpressionAttributeNames={f"#{k}": k for k in fields},
                          ExpressionAttributeValues={f":{k}": v for k, v in fields.items()})
    except Exception as error:
        log("heartbeat failed:", error)


def heartbeat_loop():
    while True:
        heartbeat()
        time.sleep(15)


def update_job(job_id, **fields):
    fields["updated_at"] = now()
    table.update_item(Key={"id": job_id},
                      UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in fields),
                      ExpressionAttributeNames={f"#{k}": k for k in fields},
                      ExpressionAttributeValues={f":{k}": v for k, v in fields.items()})


# ------------------------------------------------------------------ setup

def run_setup():
    set_state("setup", "Sunucu hazırlanıyor")
    process = subprocess.Popen(["bash", str(APP / "worker/setup.sh")], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True)
    for line in process.stdout:
        line = line.rstrip()
        log("setup:", line)
        if line.startswith("::step::"):
            set_state("setup", line.removeprefix("::step::").strip())
    code = process.wait()
    if code == 100:
        set_state("setup", "Sürücü kuruldu, yeniden başlatılıyor")
        subprocess.run(["systemctl", "reboot"])
        time.sleep(600)
    if code != 0:
        raise RuntimeError(f"setup.sh failed with exit code {code}")


def turbo_headers():
    key = Path("/opt/yue/secret.env").read_text().strip().split("=", 1)[1]
    return {"Authorization": f"Bearer {key}"}


def start_turbo():
    global turbo_up
    set_state("loading", "Model GPU'ya yükleniyor")
    subprocess.run(["systemctl", "restart", "yue2-serve.service"], check=True)
    started = time.monotonic()
    deadline = time.time() + 30 * 60
    while time.time() < deadline:
        try:
            response = requests.get(f"{TURBO}/health/ready", timeout=5)
            if response.status_code == 200:
                turbo_up = True
                log(f"model load {time.monotonic() - started:.0f}s")
                table.update_item(Key={"id": WORKER_ID}, UpdateExpression="SET load_seconds = :l",
                                  ExpressionAttributeValues={":l": int(time.monotonic() - started)})
                touch()
                return
            if response.json().get("status") == "failed":
                raise RuntimeError("YuE2-Turbo startup failed, see /var/log/yue2-serve.log")
        except requests.RequestException:
            pass
        if subprocess.run(["systemctl", "is-failed", "--quiet", "yue2-serve.service"]).returncode == 0:
            raise RuntimeError("yue2-serve.service crashed, see /var/log/yue2-serve.log")
        time.sleep(5)
    raise RuntimeError("YuE2-Turbo did not become ready in 30 minutes")


# ------------------------------------------------------------------ jobs

def recover_orphans():
    """Jobs and tasks this box claimed before a crash/stop go back to the queue."""
    for owner in ("me", TASKS):
        items = table.query(IndexName="history", KeyConditionExpression=Key("owner").eq(owner),
                            ScanIndexForward=False, Limit=100)["Items"]
        for job in items:
            if job.get("status") != "running":
                continue
            attempts = int(job.get("attempts", 1))
            if attempts >= MAX_ATTEMPTS:
                update_job(job["id"], status="failed", stage="failed", finished_at=now(),
                           error="Sunucu iş sırasında durdu (2 deneme)")
                if job.get("kind") == "stems":
                    update_job(job["job_id"], stems_status="failed", stems_error="Sunucu iş sırasında durdu, tekrar deneyin")
            else:
                log("requeue orphan", job["id"])
                update_job(job["id"], status="queued", stage="queued", message="Yeniden sırada", queue="q")
                if job.get("kind") == "stems":
                    update_job(job["job_id"], stems_status="queued", stems_message="Yeniden sırada")


def claim(job):
    """Returns the claimed item as stored (with its real started_at), or None if someone else took it."""
    try:
        return table.update_item(
            Key={"id": job["id"]},
            UpdateExpression="SET #s = :r, stage = :st, message = :m, started_at = :t, updated_at = :t, "
                             "attempts = if_not_exists(attempts, :zero) + :one REMOVE #q",
            ConditionExpression="#s = :queued",
            ExpressionAttributeNames={"#s": "status", "#q": "queue"},
            ExpressionAttributeValues={":r": "running", ":st": "preparing", ":m": "Hazırlanıyor",
                                       ":t": now(), ":queued": "queued", ":zero": 0, ":one": 1},
            ReturnValues="ALL_NEW")["Attributes"]
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        return None


STAGE_TEXT = {
    "queued": "GPU sırasında",
    "running": "Başlıyor",
    "transcribing": "Melodi çıkarılıyor (SheetSage2)",
    "planning": "Nota planı yazılıyor",
    "semantic": "Şarkı üretiliyor",
    "synthesis": "Akustik sentez",
    "decode": "Ses çözülüyor",
    "saving": "Kaydediliyor",
}


def process(job):
    global stop_requested
    job_id = job["id"]
    touch()
    work = WORK / job_id
    work.mkdir(parents=True, exist_ok=True)
    try:
        # A corrected score saved on the source goes to YuE2 directly (no SheetSage2 transcription);
        # otherwise the recording is sent and the melody is extracted from it.
        score = None
        if job.get("score_key"):
            score = s3.get_object(Bucket=BUCKET, Key=job["score_key"])["Body"].read().decode("utf-8")
        else:
            source = work / Path(job["upload_key"]).name
            s3.download_file(BUCKET, job["upload_key"], str(source))
        update_job(job_id, stage="submitting", message="Modele gönderiliyor")
        # The inference worker restarts itself after a failed job; wait instead of failing.
        deadline = time.time() + 10 * 60
        while True:
            touch()
            headers = {**turbo_headers(), "Idempotency-Key": job_id}
            if score is not None:
                response = requests.post(
                    f"{TURBO}/v1/jobs", headers=headers, timeout=120,
                    json={"style": job["style"], "lyrics": job["lyrics"], "seed": int(job["seed"]),
                          "cot": "melody", "abc": score})
            else:
                with source.open("rb") as handle:
                    response = requests.post(
                        f"{TURBO}/v1/covers", headers=headers,
                        files={"audio": (source.name, handle)},
                        data={"style": job["style"], "lyrics": job["lyrics"], "seed": str(int(job["seed"]))},
                        timeout=120)
            if response.status_code != 503 or time.time() > deadline:
                break
            update_job(job_id, message="Model hazırlanıyor, bekleniyor")
            time.sleep(5)
        if response.status_code >= 400:
            raise RuntimeError(f"Model isteği reddetti: {response.text[:300]}")
        turbo_id = response.json()["id"]
        update_job(job_id, turbo_id=turbo_id)

        last_stage = None
        last_write = 0
        while True:
            time.sleep(2)
            touch()
            status = requests.get(f"{TURBO}/v1/jobs/{turbo_id}", headers=turbo_headers(), timeout=30).json()
            record = table.get_item(Key={"id": job_id}, ProjectionExpression="cancel_requested").get("Item", {})
            if record.get("cancel_requested"):
                requests.post(f"{TURBO}/v1/jobs/{turbo_id}/cancel", headers=turbo_headers(), timeout=30)
            stage = status.get("stage") or status.get("status")
            if status["status"] in ("succeeded", "truncated", "failed", "cancelled"):
                break
            if stage != last_stage or time.time() - last_write > 10:
                update_job(job_id, stage=stage, message=STAGE_TEXT.get(stage, stage),
                           tokens=status.get("tokens") or {})
                last_stage, last_write = stage, time.time()

        if status["status"] == "cancelled":
            update_job(job_id, status="cancelled", stage="cancelled", message="İptal edildi", finished_at=now())
            return
        if status["status"] == "failed":
            error = status.get("error") or {}
            message = error.get("message") or ""
            if score is not None:
                message = (f"Model düzeltilmiş notadan düzenleme üretemedi: {message or 'bilinmeyen hata'}. "
                           "Notayı kontrol edin veya bestenin notasını özgün haline döndürün.")
            elif not message or message.startswith("Inference failed"):
                message = ("Model bu besteden düzenleme üretemedi (çoğunlukla melodi çıkarılamadığında olur). "
                           "Başka bir kayıt veya farklı bir kesit deneyin.")
            raise RuntimeError(message)

        update_job(job_id, stage="publishing", message="Dosyalar hazırlanıyor")
        flac, mp3, abc = work / "cover.flac", work / "cover.mp3", work / "score.abc"
        download(f"{TURBO}/v1/jobs/{turbo_id}/audio", flac)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(flac), "-codec:a", "libmp3lame",
                        "-b:a", "320k", str(mp3)], check=True)
        keys = {"flac_key": f"outputs/{job_id}/cover.flac", "mp3_key": f"outputs/{job_id}/cover.mp3"}
        s3.upload_file(str(flac), BUCKET, keys["flac_key"], ExtraArgs={"ContentType": "audio/flac"})
        s3.upload_file(str(mp3), BUCKET, keys["mp3_key"], ExtraArgs={"ContentType": "audio/mpeg"})
        if download(f"{TURBO}/v1/jobs/{turbo_id}/score", abc, required=False):
            keys["abc_key"] = f"outputs/{job_id}/score.abc"
            s3.upload_file(str(abc), BUCKET, keys["abc_key"], ExtraArgs={"ContentType": "text/plain; charset=utf-8"})
        result = status.get("result") or {}
        timing = result.get("timing") or {}
        stems = stems_fields(job)
        update_job(job_id, status="succeeded", stage="done", message="Hazır", finished_at=now(), **stems,
                   duration=Decimal(str(round(float(result.get("audio_seconds") or 0), 1))),
                   truncated=status["status"] == "truncated",
                   gpu_seconds=now() - int(job.get("started_at") or now()),   # wall seconds of this attempt
                   timing=json.loads(json.dumps(timing), parse_float=lambda v: str(v)), **keys)
        if stems.get("stems_status") == "queued":
            queue_stems(job_id)
        log("done", job_id)
    except Exception as error:
        traceback.print_exc()
        update_job(job_id, status="failed", stage="failed", message="Hata", error=str(error)[:500],
                   finished_at=now())
    finally:
        # The last cover to finish decides whether the box stops as soon as the queue is empty.
        stop_requested = bool(job.get("stop_after"))
        subprocess.run(["rm", "-rf", str(work)])
        active.pop(job_id, None)
        touch()


def stems_fields(job):
    """Every finished cover is split into instrumental + vocals right away (same GPU session)."""
    if job.get("auto_stems") is False:
        return {}
    if Path("/opt/yue/sep/.installed").exists():
        return {"stems_status": "queued", "stems_message": "Sırada"}
    return {"stems_status": "failed", "stems_error": "Vokal ayırıcı bu sunucuda kurulu değil; teknik ekibe haber verin"}


def queue_stems(job_id):
    """Queue the split after the cover is stored; a queueing problem must never fail the cover itself."""
    try:
        created = now()
        table.put_item(Item={"id": uuid.uuid4().hex, "owner": TASKS, "kind": "stems", "job_id": job_id,
                             "queue": "q", "status": "queued", "stage": "queued", "message": "Sırada",
                             "created_at": created * 1000, "updated_at": created})
    except Exception:
        traceback.print_exc()
        update_job(job_id, stems_status="failed", stems_error="Vokal ayırma sıraya alınamadı")


def stop_turbo():
    """Free the GPU for the separator; the work loop restarts YuE2 when the next cover is claimed."""
    global turbo_up
    turbo_up = False
    subprocess.run(["systemctl", "stop", "yue2-serve.service"])


def separate(source, out):
    names = json.dumps({"Instrumental": "instrumental", "Vocals": "vocals"})
    return subprocess.run(
        [SEPARATOR, str(source), "-m", SEPARATOR_MODEL, "--model_file_dir", SEPARATOR_MODELS,
         "--output_dir", str(out), "--output_format", "FLAC", "--sample_rate", "48000",
         "--custom_output_names", names],
        capture_output=True, text=True, timeout=SEPARATOR_TIMEOUT)


def process_stems(task):
    """Split a finished cover into instrumental + vocals with BS-RoFormer."""
    task_id, job_id = task["id"], task["job_id"]
    touch()
    work = WORK / task_id
    out = work / "out"
    out.mkdir(parents=True, exist_ok=True)
    try:
        job = table.get_item(Key={"id": job_id}).get("Item")
        if not job or not job.get("flac_key"):
            raise RuntimeError("Şarkı bulunamadı")
        if not Path("/opt/yue/sep/.installed").exists():
            raise RuntimeError("Vokal ayırıcı bu sunucuda kurulamadı; teknik ekibe haber verin")
        update_job(job_id, stems_status="running", stems_message="Vokal ayrılıyor")
        source = work / "cover.flac"
        s3.download_file(BUCKET, job["flac_key"], str(source))
        stop_turbo()
        started = time.time()
        try:
            result = separate(source, out)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Vokal ayırma {SEPARATOR_TIMEOUT // 60} dakikada bitmedi, durduruldu; tekrar deneyin")
        if result.returncode != 0 and "out of memory" in (result.stdout + result.stderr).lower():
            # Never fall back to CPU (a 4 vCPU box takes far too long): requeue for a fresh GPU attempt.
            log("separator OOM on GPU", task_id)
            if int(task.get("attempts", 1)) < MAX_ATTEMPTS:
                update_job(task_id, status="queued", stage="queued", message="Yeniden sırada", queue="q")
                update_job(job_id, stems_status="queued", stems_message="GPU doluydu, yeniden sırada")
                return
            raise RuntimeError("Vokal ayırma GPU belleğine sığmadı; tekrar deneyin")
        if result.returncode != 0:
            log("separator failed:", result.stdout[-2000:], result.stderr[-2000:])
            raise RuntimeError("Vokal ayırma başarısız: " + (result.stderr or result.stdout).strip()[-300:])
        instrumental, vocals = out / "instrumental.flac", out / "vocals.flac"
        if not instrumental.exists() or not vocals.exists():
            raise RuntimeError(f"Ayırıcı beklenen dosyaları üretmedi: {sorted(p.name for p in out.iterdir())}")
        mp3 = work / "instrumental.mp3"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(instrumental), "-codec:a", "libmp3lame",
                        "-b:a", "320k", str(mp3)], check=True)
        keys = {"instrumental_key": f"outputs/{job_id}/instrumental.flac",
                "instrumental_mp3_key": f"outputs/{job_id}/instrumental.mp3",
                "vocals_key": f"outputs/{job_id}/vocals.flac"}
        s3.upload_file(str(instrumental), BUCKET, keys["instrumental_key"], ExtraArgs={"ContentType": "audio/flac"})
        s3.upload_file(str(mp3), BUCKET, keys["instrumental_mp3_key"], ExtraArgs={"ContentType": "audio/mpeg"})
        s3.upload_file(str(vocals), BUCKET, keys["vocals_key"], ExtraArgs={"ContentType": "audio/flac"})
        update_job(job_id, stems_status="succeeded", stems_message="Hazır",
                   stems_seconds=int(time.time() - started), **keys)
        update_job(task_id, status="succeeded", stage="done", message="Hazır", finished_at=now())
        log("stems done", job_id, f"{time.time() - started:.0f}s")
    except Exception as error:
        traceback.print_exc()
        update_job(job_id, stems_status="failed", stems_error=str(error)[:500])
        update_job(task_id, status="failed", stage="failed", message="Hata", error=str(error)[:500], finished_at=now())
    finally:
        subprocess.run(["rm", "-rf", str(work)])
        active.pop(task_id, None)
        touch()


def download(url, path, required=True):
    response = requests.get(url, headers=turbo_headers(), timeout=300, stream=True)
    if response.status_code != 200:
        if required:
            raise RuntimeError(f"İndirme başarısız: {url} -> {response.status_code}")
        return False
    with path.open("wb") as handle:
        for chunk in response.iter_content(1 << 20):
            handle.write(chunk)
    return True


def work_loop():
    set_state("ready", "Hazır")
    log(f"boot-to-ready {time.monotonic() - BOOT_STARTED:.0f}s")
    table.update_item(Key={"id": WORKER_ID}, UpdateExpression="SET boot_seconds = :b",
                      ExpressionAttributeValues={":b": int(time.monotonic() - BOOT_STARTED)})
    touch()
    kinds = {}          # job id -> "stems" / "cover" for the running work
    idle_minutes, idle_checked = IDLE_MINUTES, 0.0
    while True:
        if time.time() - idle_checked > 30:
            # The API publishes the current idle limit; /etc/yue.env is frozen at first boot.
            idle_checked = time.time()
            try:
                value = table.get_item(Key={"id": WORKER_ID}, ProjectionExpression="idle_minutes").get("Item", {}).get("idle_minutes")
                if value:
                    idle_minutes = int(value)
            except Exception:
                traceback.print_exc()
        queue = []
        if len(active) < MAX_PARALLEL:
            queue = table.query(IndexName="queue", KeyConditionExpression=Key("queue").eq("q"),
                                Limit=25)["Items"]
            # Covers first. A separation stops YuE2 to get the whole GPU, so it runs alone:
            # only when no cover is running or waiting, and no cover starts until it is done.
            queue.sort(key=lambda item: item.get("kind") == "stems")
            covers_waiting = any(item.get("kind") != "stems" for item in queue)
            for job in queue:
                if len(active) >= MAX_PARALLEL or any(kinds.get(i) == "stems" for i in list(active)):
                    break
                kind = "stems" if job.get("kind") == "stems" else "cover"
                if kind == "stems" and (active or covers_waiting):
                    continue
                if kind == "cover" and not turbo_up:
                    start_turbo()
                claimed = claim(job)
                if claimed:
                    log("claimed", kind, job["id"])
                    target = process_stems if kind == "stems" else process
                    thread = threading.Thread(target=target, args=(claimed,), daemon=True)
                    active[job["id"]] = thread
                    kinds[job["id"]] = kind
                    thread.start()
        busy = bool(active)
        if any(kinds.get(i) == "stems" for i in list(active)):
            message = "Vokal ayrılıyor"
        else:
            message = f"{len(active)} düzenleme yapılıyor" if busy else "Hazır, iş bekliyor"
        with state_lock:
            state.update(state="busy" if busy else "ready", message=message)
        idle = time.time() - last_activity
        if not busy and stop_requested and not queue and idle > STOP_GRACE:
            power_off("Üretim bitti, GPU kapatılıyor")
        if not busy and idle > idle_minutes * 60:
            power_off(f"{idle_minutes} dk boşta kaldı, GPU kapanıyor")
        time.sleep(3)


def power_off(message):
    set_state("stopping", message)
    log(message)
    subprocess.run(["systemctl", "stop", "yue2-serve.service"])
    subprocess.run(["systemctl", "poweroff"])
    time.sleep(300)


def main():
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    try:
        recover_orphans()
        run_setup()
        work_loop()       # YuE2 is loaded lazily, only when a cover is claimed (a stems-only boot never loads it)
    except Exception as error:
        traceback.print_exc()
        set_state("error", f"Hata: {str(error)[:300]}")
        # Stay up briefly for debugging via SSM, then power off so nothing burns money.
        time.sleep(20 * 60)
        subprocess.run(["systemctl", "poweroff"])


if __name__ == "__main__":
    main()
