"""yue API (Lambda Function URL behind CloudFront /api/*) and janitor.

The GPU instance is normally stopped. Submitting a job starts it; the worker
agent on the instance stops it after YUE_IDLE_MINUTES without work, and the
janitor (every 5 min) is the safety net for both directions.
"""
import base64
import hmac
import json
import os
import re
import time
import uuid

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "eu-central-1")
BUCKET = os.environ["YUE_BUCKET"]
TABLE = os.environ["YUE_TABLE"]
INSTANCE_ID = os.environ["YUE_INSTANCE_ID"]
PRIMARY_TYPE = os.environ.get("YUE_PRIMARY_TYPE", "g6.2xlarge")
FALLBACK_TYPES = [t for t in os.environ.get("YUE_FALLBACK_TYPES", "").split(",") if t]
IDLE_MINUTES = int(os.environ.get("YUE_IDLE_MINUTES", "10"))
PASSCODE_PARAM = os.environ.get("YUE_PASSCODE_PARAM", "/yue/passcode")

OWNER = "me"
WORKER_ID = "__worker__"
MAX_UPLOAD = 40 * 1024 * 1024
AUDIO_EXT = {"mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "webm", "aiff", "aif"}
# A running job that has not been touched for this long is considered lost.
STALE_RUNNING_SECONDS = 30 * 60
# Agent heartbeat older than this means the agent is dead.
STALE_HEARTBEAT_SECONDS = 15 * 60

s3 = boto3.client("s3", region_name=REGION,
                  config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))
ec2 = boto3.client("ec2", region_name=REGION)
ssm = boto3.client("ssm", region_name=REGION)
table = boto3.resource("dynamodb", region_name=REGION).Table(TABLE)

_passcode = None


def now():
    return int(time.time())


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(body, default=_json_default),
    }


def _json_default(value):
    # DynamoDB returns Decimal
    if hasattr(value, "is_integer"):
        return int(value) if value == int(value) else float(value)
    raise TypeError(type(value))


def passcode():
    global _passcode
    if _passcode is None:
        _passcode = ssm.get_parameter(Name=PASSCODE_PARAM, WithDecryption=True)["Parameter"]["Value"]
    return _passcode


def authorize(headers):
    given = headers.get("x-passcode", "")
    if not given or not hmac.compare_digest(given.encode(), passcode().encode()):
        raise HttpError(401, "Şifre hatalı")


def parse_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        raise HttpError(400, "Geçersiz JSON")
    if not isinstance(body, dict):
        raise HttpError(400, "Geçersiz istek")
    return body


# ---------------------------------------------------------------- GPU control

def describe_gpu():
    reservations = ec2.describe_instances(InstanceIds=[INSTANCE_ID])["Reservations"]
    instance = reservations[0]["Instances"][0]
    return {"state": instance["State"]["Name"], "type": instance["InstanceType"],
            "launched_at": int(instance["LaunchTime"].timestamp())}


def ensure_gpu():
    """Start the GPU if it is stopped. Falls back to other instance types when
    AWS has no capacity for the current one. Returns the resulting state."""
    gpu = describe_gpu()
    if gpu["state"] in ("running", "pending"):
        return gpu["state"]
    if gpu["state"] != "stopped":
        # stopping / shutting-down: the janitor starts it on its next tick.
        return gpu["state"]
    candidates = [gpu["type"]] + [t for t in [PRIMARY_TYPE] + FALLBACK_TYPES if t != gpu["type"]]
    last_error = None
    for index, instance_type in enumerate(candidates):
        try:
            if instance_type != gpu["type"]:
                ec2.modify_instance_attribute(InstanceId=INSTANCE_ID, InstanceType={"Value": instance_type})
                gpu["type"] = instance_type
            ec2.start_instances(InstanceIds=[INSTANCE_ID])
            set_worker(requested_type=instance_type, start_requested_at=now(),
                       state="booting", message="GPU sunucusu açılıyor")
            return "pending"
        except ClientError as error:
            code = error.response["Error"]["Code"]
            last_error = code
            if code not in ("InsufficientInstanceCapacity", "Unsupported", "InstanceLimitExceeded",
                            "VcpuLimitExceeded"):
                raise
            print(f"start failed on {instance_type}: {code}")
    set_worker(state="no_capacity", message=f"AWS'de şu an GPU kapasitesi yok ({last_error}); tekrar denenecek")
    return "no_capacity"


def stop_gpu(reason):
    gpu = describe_gpu()
    if gpu["state"] in ("running", "pending"):
        print(f"stopping GPU: {reason}")
        ec2.stop_instances(InstanceIds=[INSTANCE_ID])
        set_worker(state="stopping", message=reason)
        return True
    return False


def set_worker(**fields):
    fields["updated_at"] = now()
    names = {f"#{k}": k for k in fields}
    values = {f":{k}": v for k, v in fields.items()}
    table.update_item(Key={"id": WORKER_ID},
                      UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in fields),
                      ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def get_worker():
    return table.get_item(Key={"id": WORKER_ID}).get("Item") or {}


# ---------------------------------------------------------------- jobs

def queued_jobs():
    return table.query(IndexName="queue", KeyConditionExpression=Key("queue").eq("q"))["Items"]


def recent_jobs(limit=60):
    return table.query(IndexName="history", KeyConditionExpression=Key("owner").eq(OWNER),
                       ScanIndexForward=False, Limit=limit)["Items"]


def presign_get(key, filename=None):
    params = {"Bucket": BUCKET, "Key": key}
    if filename:
        params["ResponseContentDisposition"] = f'attachment; filename="{filename}"'
    return s3.generate_presigned_url("get_object", Params=params, ExpiresIn=6 * 3600)


def safe_filename(title, ext):
    base = re.sub(r"[^\w\- ]+", "", title or "cover", flags=re.UNICODE).strip() or "cover"
    return f"{base[:60]}.{ext}"


def public_job(job):
    out = {k: job.get(k) for k in (
        "id", "group", "title", "style", "lyrics", "seed", "status", "stage", "message", "error",
        "created_at", "started_at", "finished_at", "duration", "source_name", "tokens", "variant",
        "upload_key")}
    if job.get("status") == "succeeded":
        if job.get("mp3_key"):
            out["mp3_url"] = presign_get(job["mp3_key"])
            out["mp3_download"] = presign_get(job["mp3_key"], safe_filename(job.get("title"), "mp3"))
        if job.get("flac_key"):
            out["flac_download"] = presign_get(job["flac_key"], safe_filename(job.get("title"), "flac"))
        if job.get("abc_key"):
            out["abc_download"] = presign_get(job["abc_key"], safe_filename(job.get("title"), "abc"))
    if job.get("upload_key"):
        out["source_url"] = presign_get(job["upload_key"])
    return out


def get_job(job_id):
    job = table.get_item(Key={"id": job_id}).get("Item")
    if not job or job.get("owner") != OWNER:
        raise HttpError(404, "Kayıt bulunamadı")
    return job


def validate_text(body, name, limit, required=True):
    value = body.get(name)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise HttpError(400, f"'{name}' gerekli")
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise HttpError(400, f"'{name}' geçersiz veya çok uzun")
    return value.strip()


def create_upload(body):
    name = validate_text(body, "filename", 200)
    size = body.get("size")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in AUDIO_EXT:
        raise HttpError(400, "Desteklenen formatlar: " + ", ".join(sorted(AUDIO_EXT)))
    if not isinstance(size, int) or size <= 0 or size > MAX_UPLOAD:
        raise HttpError(400, "Dosya en fazla 40 MB olabilir")
    key = f"uploads/{uuid.uuid4().hex}.{ext}"
    content_type = body.get("content_type") or "application/octet-stream"
    url = s3.generate_presigned_url("put_object", ExpiresIn=900,
                                    Params={"Bucket": BUCKET, "Key": key, "ContentType": content_type})
    return {"key": key, "url": url, "content_type": content_type}


def create_jobs(body):
    upload_key = validate_text(body, "upload_key", 200)
    if not re.fullmatch(r"uploads/[0-9a-f]{32}\.[a-z0-9]+", upload_key):
        raise HttpError(400, "Geçersiz dosya anahtarı")
    try:
        s3.head_object(Bucket=BUCKET, Key=upload_key)
    except ClientError:
        raise HttpError(400, "Yüklenen dosya bulunamadı, tekrar yükleyin")
    style = validate_text(body, "style", 2000)
    lyrics = validate_text(body, "lyrics", 16000)
    title = validate_text(body, "title", 120, required=False) or "Adsız cover"
    source_name = validate_text(body, "source_name", 200, required=False)
    variants = body.get("variants", 1)
    if variants not in (1, 2):
        raise HttpError(400, "variants 1 veya 2 olmalı")
    seed = body.get("seed")
    if seed is None:
        seed = int.from_bytes(os.urandom(4), "big")
    if not isinstance(seed, int) or not 0 <= seed < 2**31:
        raise HttpError(400, "seed 0 ile 2^31 arasında bir tam sayı olmalı")

    group = uuid.uuid4().hex[:12]
    created = now()
    jobs = []
    for index in range(variants):
        job = {
            "id": uuid.uuid4().hex, "owner": OWNER, "group": group, "variant": index + 1,
            "queue": "q", "created_at": created * 1000 + index, "updated_at": created,
            "status": "queued", "stage": "queued", "message": "Sırada",
            "title": title, "style": style, "lyrics": lyrics, "seed": seed + index * 7919,
            "upload_key": upload_key, "source_name": source_name,
        }
        table.put_item(Item=job)
        jobs.append(job)
    gpu_state = ensure_gpu()
    return {"jobs": [public_job(j) for j in jobs], "gpu": gpu_state}


def cancel_job(job_id):
    job = get_job(job_id)
    if job["status"] == "queued":
        table.update_item(Key={"id": job_id}, UpdateExpression="SET #s = :c, stage = :c, message = :m, updated_at = :t REMOVE #q",
                          ConditionExpression="#s = :queued",
                          ExpressionAttributeNames={"#s": "status", "#q": "queue"},
                          ExpressionAttributeValues={":c": "cancelled", ":m": "İptal edildi", ":t": now(), ":queued": "queued"})
    elif job["status"] == "running":
        table.update_item(Key={"id": job_id}, UpdateExpression="SET cancel_requested = :y, updated_at = :t",
                          ExpressionAttributeValues={":y": True, ":t": now()})
    return public_job(get_job(job_id))


def delete_job(job_id):
    job = get_job(job_id)
    if job["status"] in ("queued", "running"):
        raise HttpError(409, "Önce işi iptal edin")
    for key in ("mp3_key", "flac_key", "abc_key"):
        if job.get(key):
            s3.delete_object(Bucket=BUCKET, Key=job[key])
    table.delete_item(Key={"id": job_id})
    return {"deleted": job_id}


def status():
    gpu = describe_gpu()
    worker = get_worker()
    queue = queued_jobs()
    return {
        "gpu": gpu,
        "worker": {k: worker.get(k) for k in ("state", "message", "heartbeat_at", "last_activity_at",
                                              "boot_seconds", "instance_type", "requested_type")},
        "queued": len(queue),
        "idle_minutes": IDLE_MINUTES,
        "now": now(),
    }


ROUTES = [
    ("POST", r"/api/login", lambda e, m: {"ok": True}),
    ("GET", r"/api/status", lambda e, m: status()),
    ("POST", r"/api/uploads", lambda e, m: create_upload(parse_body(e))),
    ("POST", r"/api/jobs", lambda e, m: create_jobs(parse_body(e))),
    ("GET", r"/api/jobs", lambda e, m: {"jobs": [public_job(j) for j in recent_jobs()]}),
    ("GET", r"/api/jobs/([0-9a-f]{32})", lambda e, m: public_job(get_job(m.group(1)))),
    ("POST", r"/api/jobs/([0-9a-f]{32})/cancel", lambda e, m: cancel_job(m.group(1))),
    ("DELETE", r"/api/jobs/([0-9a-f]{32})", lambda e, m: delete_job(m.group(1))),
    ("POST", r"/api/gpu/start", lambda e, m: {"gpu": ensure_gpu()}),
    ("POST", r"/api/gpu/stop", lambda e, m: {"stopped": stop_gpu("Kullanıcı tarafından durduruldu")}),
]


def api(event, context):
    method = event["requestContext"]["http"]["method"]
    path = event.get("rawPath", "/")
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    if path == "/api/health":
        return response(200, {"ok": True})
    try:
        for route_method, pattern, handler in ROUTES:
            match = re.fullmatch(pattern, path)
            if match and method == route_method:
                authorize(headers)
                return response(200, handler(event, match))
        raise HttpError(404, "Bulunamadı")
    except HttpError as error:
        return response(error.status, {"error": error.message})
    except ClientError as error:
        print("aws error", error)
        return response(502, {"error": error.response["Error"].get("Message", "AWS hatası")})


# ---------------------------------------------------------------- janitor

def janitor(event, context):
    t = now()
    gpu = describe_gpu()
    worker = get_worker()
    queue = queued_jobs()
    running = [j for j in recent_jobs(100) if j.get("status") == "running"]

    for job in running:
        if t - int(job.get("updated_at", 0)) > STALE_RUNNING_SECONDS:
            print("failing stale job", job["id"])
            table.update_item(Key={"id": job["id"]},
                              UpdateExpression="SET #s = :f, stage = :f, #e = :e, finished_at = :t, updated_at = :t",
                              ExpressionAttributeNames={"#s": "status", "#e": "error"},
                              ExpressionAttributeValues={":f": "failed", ":t": t,
                                                         ":e": "İş zaman aşımına uğradı (sunucu yanıt vermedi)"})
    running = [j for j in running if t - int(j.get("updated_at", 0)) <= STALE_RUNNING_SECONDS]

    if gpu["state"] == "stopped":
        if queue:
            print("jobs waiting, starting GPU:", ensure_gpu())
        elif worker.get("state") not in (None, "stopped"):
            set_worker(state="stopped", message="GPU kapalı (boşta)")
        return {"gpu": "stopped", "queued": len(queue)}

    if gpu["state"] != "running":
        return {"gpu": gpu["state"]}

    heartbeat = int(worker.get("heartbeat_at") or 0)
    last_activity = max(int(worker.get("last_activity_at") or 0), heartbeat if worker.get("state") == "setup" else 0,
                        gpu["launched_at"])
    idle_for = t - last_activity
    agent_dead = t - max(heartbeat, gpu["launched_at"]) > STALE_HEARTBEAT_SECONDS
    # First boot installs drivers/models and can take ~30 min; the agent heartbeats throughout.
    if agent_dead:
        stop_gpu("Worker yanıt vermiyor, GPU durduruldu")
    elif not queue and not running and idle_for > (IDLE_MINUTES + 5) * 60:
        stop_gpu(f"{IDLE_MINUTES} dakikadan uzun süre boşta")
    return {"gpu": gpu["state"], "idle_for": idle_for, "queued": len(queue), "running": len(running)}
