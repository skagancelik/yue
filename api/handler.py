"""yue API (Lambda Function URL behind CloudFront /api/*) and janitor.

The GPU instance is normally stopped. Submitting a job starts it; the worker
agent on the instance stops it after YUE_IDLE_MINUTES without work, and the
janitor (every 5 min) is the safety net for both directions.
"""
import base64
from decimal import Decimal
import hmac
import json
import os
import re
import time
import unicodedata
from urllib.parse import quote
import uuid

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "eu-central-1")
BUCKET = os.environ["YUE_BUCKET"]
TABLE = os.environ["YUE_TABLE"]
INSTANCE_ID = os.environ["YUE_INSTANCE_ID"]
PRIMARY_TYPE = os.environ.get("YUE_PRIMARY_TYPE", "g6.xlarge")
FALLBACK_TYPES = [t for t in os.environ.get("YUE_FALLBACK_TYPES", "").split(",") if t]
IDLE_MINUTES = int(os.environ.get("YUE_IDLE_MINUTES", "10"))
PASSCODE_PARAM = os.environ.get("YUE_PASSCODE_PARAM", "/yue/passcode")

OWNER = "me"
# Other item kinds share the table and the `history` index under their own owner value.
FOLDERS = "folders"
SOURCES = "sources"
STYLES = "styles"
TASKS = "tasks"            # GPU queue items that are not covers (stem separation)
STEM_KEYS = ("instrumental_key", "instrumental_mp3_key", "vocals_key")
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
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
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


def ensure_gpu(quick=False):
    """Start the GPU if it is stopped. Falls back to other instance types when
    AWS has no capacity for the current one. Returns the resulting state.

    quick=True (API requests) only tries the current type so the request stays
    well under CloudFront's 30 s origin timeout; the janitor walks the fallbacks."""
    gpu = describe_gpu()
    if gpu["state"] in ("running", "pending"):
        return gpu["state"]
    if gpu["state"] != "stopped":
        # stopping / shutting-down: the janitor starts it on its next tick.
        return gpu["state"]
    candidates = [gpu["type"]] + [t for t in dict.fromkeys([PRIMARY_TYPE] + FALLBACK_TYPES) if t != gpu["type"]]
    if quick:
        candidates = candidates[:1]
    last_error = None
    for index, instance_type in enumerate(candidates):
        try:
            if instance_type != gpu["type"]:
                ec2.modify_instance_attribute(InstanceId=INSTANCE_ID, InstanceType={"Value": instance_type})
                gpu["type"] = instance_type
            ec2.start_instances(InstanceIds=[INSTANCE_ID])
            set_worker(requested_type=instance_type, start_requested_at=now(), idle_minutes=IDLE_MINUTES,
                       state="booting", message="GPU sunucusu açılıyor")
            return "pending"
        except ClientError as error:
            code = error.response["Error"]["Code"]
            last_error = code
            if code not in ("InsufficientInstanceCapacity", "Unsupported", "InstanceLimitExceeded",
                            "VcpuLimitExceeded"):
                raise
            print(f"start failed on {instance_type}: {code}")
    message = f"AWS'de şu an GPU kapasitesi yok ({last_error}); " + (
        "diğer GPU tipleri birkaç dakika içinde denenecek" if quick else "5 dakikada bir tekrar denenecek")
    set_worker(state="no_capacity", message=message)
    return "no_capacity"


def stop_gpu(reason, failed=False):
    """failed=True (dead agent, stuck box) and an existing worker error are latched: the state stays
    "error" so the janitor does not restart a broken box on its own (only a user action retries)."""
    gpu = describe_gpu()
    if gpu["state"] in ("running", "pending"):
        print(f"stopping GPU: {reason}")
        ec2.stop_instances(InstanceIds=[INSTANCE_ID])
        if failed or get_worker().get("state") == "error":
            set_worker(state="error", message=reason)
        else:
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


def all_items(owner):
    """Every item of one kind, newest first (single user, so this stays small)."""
    items, kwargs = [], {}
    while True:
        page = table.query(IndexName="history", KeyConditionExpression=Key("owner").eq(owner),
                           ScanIndexForward=False, **kwargs)
        items += page["Items"]
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def get_item(item_id, owner, missing):
    item = table.get_item(Key={"id": item_id}).get("Item")
    if not item or item.get("owner") != owner:
        raise HttpError(404, missing)
    return item


def presign_get(key, filename=None):
    params = {"Bucket": BUCKET, "Key": key}
    if filename:
        # S3 only accepts ISO-8859-1 header values, so Turkish letters (ı, ş, ğ) go in the
        # RFC 5987 filename* parameter, with an ASCII fallback for old clients.
        ascii_name = unicodedata.normalize("NFKD", filename.replace("ı", "i").replace("İ", "I"))
        ascii_name = ascii_name.encode("ascii", "ignore").decode() or "duzenleme"
        params["ResponseContentDisposition"] = (
            f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename)}')
    return s3.generate_presigned_url("get_object", Params=params, ExpiresIn=6 * 3600)


def safe_filename(title, ext):
    base = re.sub(r"[^\w\- ]+", "", title or "duzenleme", flags=re.UNICODE).strip() or "duzenleme"
    return f"{base[:60]}.{ext}"


def public_job(job):
    out = {k: job.get(k) for k in (
        "id", "group", "title", "style", "lyrics", "seed", "status", "stage", "message", "error",
        "created_at", "started_at", "finished_at", "duration", "source_name", "tokens", "variant",
        "upload_key", "folder_id", "source_id", "stems_status", "stems_message", "stems_error", "lyrics_start", "lyrics_layout",
        "style_base")}
    # Where the score YuE2 got came from: "prepared" (laid out in the timeline and converted by the
    # browser), "edited" (the source's corrected score), "transcript" (the source's saved transcription),
    # or none (the recording was transcribed in the job). Older jobs with a score only had edited ones.
    out["score_from"] = job.get("score_from") or ("edited" if job.get("score_key") else None)
    out["edited_score"] = bool(job.get("score_key"))
    out["liked"] = bool(job.get("liked"))
    out["note"] = job.get("note") or ""
    if job.get("stems_status") == "succeeded":
        name = job.get("title")
        out["instrumental_url"] = presign_get(job["instrumental_mp3_key"])
        out["vocals_url"] = presign_get(job["vocals_key"])
        out["instrumental_download"] = presign_get(job["instrumental_key"], safe_filename(f"{name} (altyapı)", "flac"))
        out["instrumental_mp3_download"] = presign_get(job["instrumental_mp3_key"], safe_filename(f"{name} (altyapı)", "mp3"))
        out["vocals_download"] = presign_get(job["vocals_key"], safe_filename(f"{name} (vokal)", "flac"))
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
    return get_item(job_id, OWNER, "Kayıt bulunamadı")


def validate_text(body, name, limit, required=True):
    value = body.get(name)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise HttpError(400, f"'{name}' gerekli")
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise HttpError(400, f"'{name}' geçersiz veya çok uzun")
    return value.strip()


def validate_flag(body, name, default=None):
    value = body.get(name, default)
    if not isinstance(value, bool):
        raise HttpError(400, f"{name} true/false olmalı")
    return value


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


def check_upload_size(key):
    """The presigned PUT does not cap the size; enforce the limit on what was really stored."""
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
    except ClientError:
        raise HttpError(400, "Yüklenen dosya bulunamadı, tekrar yükleyin")
    if head["ContentLength"] > MAX_UPLOAD:
        if key.startswith("uploads/"):
            s3.delete_object(Bucket=BUCKET, Key=key)
        raise HttpError(400, "Dosya en fazla 40 MB olabilir")
    return head


def create_jobs(body):
    # Every arrangement belongs to a song (folder); there are no unfiled ones.
    if not body.get("folder_id"):
        raise HttpError(400, "Önce bir şarkı seç; her düzenleme bir şarkıya ait olmalı")
    folder_id = validate_text(body, "folder_id", 32)
    source_id = validate_text(body, "source_id", 32, required=False)
    get_folder(folder_id)
    score_key = score_text = score_from = None
    if body.get("abc") is not None:
        # The score the browser prepared from the timeline (lyrics laid on it, unsung bars given to the
        # instrument, sections named after the lyrics). It goes to YuE2 as it is.
        if not source_id:
            raise HttpError(400, "Hazırlanmış nota yalnızca bir besteyle kullanılabilir")
        check_score(body["abc"])
        score_text, score_from = body["abc"], "prepared"
    if source_id:
        source = get_item(source_id, SOURCES, "Beste bulunamadı")
        upload_key, body["source_name"] = source["key"], source["name"]
        if score_text is None:
            # A corrected score, else the saved transcription: either skips melody extraction.
            score_key = source.get("score_key") or source.get("transcript_key")
            score_from = "edited" if source.get("score_key") else "transcript" if score_key else None
    else:
        upload_key = validate_text(body, "upload_key", 200)
    if not re.fullmatch(r"(uploads|sources)/[0-9a-f]{32}\.[a-z0-9]+", upload_key):
        raise HttpError(400, "Geçersiz dosya anahtarı")
    check_upload_size(upload_key)
    style = validate_text(body, "style", 2000)
    lyrics = validate_text(body, "lyrics", 16000)
    style_base = validate_text(body, "style_base", 2000, required=False)
    layout = validate_lyrics_layout(body.get("lyrics_layout"))
    title = validate_text(body, "title", 120, required=False) or "Adsız düzenleme"
    source_name = validate_text(body, "source_name", 200, required=False)
    auto_stems = body.get("stems", True)
    if not isinstance(auto_stems, bool):
        raise HttpError(400, "stems true/false olmalı")
    stop_after = body.get("stop_gpu", False)
    if not isinstance(stop_after, bool):
        raise HttpError(400, "stop_gpu true/false olmalı")
    variants = body.get("variants", 1)
    if variants not in (1, 2):
        raise HttpError(400, "variants 1 veya 2 olmalı")
    seed = body.get("seed")
    if seed is None:
        seed = int.from_bytes(os.urandom(4), "big") & 0x7FFFFFFF
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
        job["folder_id"] = folder_id
        if source_id:
            job["source_id"] = source_id
        if score_key or score_text is not None:
            # A copy, so saving or resetting the source's score later does not change a queued job.
            job["score_key"], job["score_from"] = f"outputs/{job['id']}/input.abc", score_from
            if score_text is not None:
                s3.put_object(Bucket=BUCKET, Key=job["score_key"], Body=score_text.encode("utf-8"),
                              ContentType="text/plain; charset=utf-8")
            else:
                s3.copy_object(Bucket=BUCKET, Key=job["score_key"], CopySource={"Bucket": BUCKET, "Key": score_key},
                               ContentType="text/plain; charset=utf-8", MetadataDirective="REPLACE")
        if style_base and style_base != style:
            job["style_base"] = style_base   # the style as written, before the tracks were added to it
        if layout:
            job["lyrics_layout"] = layout
        if not auto_stems:
            job["auto_stems"] = False
        if stop_after:
            job["stop_after"] = True
        table.put_item(Item=job)
        jobs.append(job)
    gpu_state = ensure_gpu(quick=True)
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
    if job.get("stems_status") in ("queued", "running"):
        raise HttpError(409, "Vokal ayırma sürüyor, bitmesini bekleyin")
    for key in ("mp3_key", "flac_key", "abc_key", "score_key") + STEM_KEYS:
        if job.get(key):
            s3.delete_object(Bucket=BUCKET, Key=job[key])
    table.delete_item(Key={"id": job_id})
    return {"deleted": job_id}


def request_stems(job_id):
    """Queue BS-RoFormer vocal/instrumental separation of a finished cover."""
    job = get_job(job_id)
    if job.get("status") != "succeeded" or not job.get("flac_key"):
        raise HttpError(409, "Önce düzenleme tamamlanmalı")
    if job.get("stems_status") in ("queued", "running", "succeeded"):
        return {"job": public_job(job), "gpu": describe_gpu()["state"]}
    created = now()
    table.put_item(Item={"id": uuid.uuid4().hex, "owner": TASKS, "kind": "stems", "job_id": job_id,
                         "queue": "q", "status": "queued", "stage": "queued", "message": "Sırada",
                         "created_at": created * 1000, "updated_at": created})
    table.update_item(Key={"id": job_id},
                      UpdateExpression="SET stems_status = :q, stems_message = :m REMOVE stems_error",
                      ExpressionAttributeValues={":q": "queued", ":m": "Sırada"})
    gpu_state = ensure_gpu(quick=True)
    return {"job": public_job(get_job(job_id)), "gpu": gpu_state}


def validate_lyrics_layout(layout):
    """Where the lyrics sit under the vocal notes in the score views (display only, YuE2 never sees it).
    Section form: starts = the note each lyric section starts on (null = automatic), holds = notes that
    hold the syllable before, doubles = notes that carry two syllables. Timeline form: map = the note of
    every syllable (null = none), lyrics = the arrangement's lyrics with corrected letters; at = the L:
    unit (from the start of the song) each syllable's note starts on, so the syllables find their notes
    again after the score is edited. Notes are numbered from 0."""
    if layout is None:
        return None
    note = lambda n: isinstance(n, int) and not isinstance(n, bool) and 0 <= n < 100000
    lists = ("starts", "holds", "doubles", "map", "at")
    if (not isinstance(layout, dict) or set(layout) - {*lists, "lyrics"}
            or not all(isinstance(layout.get(k, []), list) and len(layout.get(k, [])) <= 20000 for k in lists)
            or not all(n is None or note(n) for k in ("starts", "map", "at") for n in layout.get(k, []))
            or not all(note(n) for k in ("holds", "doubles") for n in layout.get(k, []))):
        raise HttpError(400, "lyrics_layout geçersiz")
    out = {k: layout[k] for k in lists if k in layout}
    if "lyrics" in layout:
        out["lyrics"] = validate_text(layout, "lyrics", 16000, required=False) or ""
    if "map" in out or "at" in out:
        return out
    return out if any(n is not None for k in out for n in out[k]) else None


def update_job_fields(job_id, body):
    job = get_job(job_id)
    fields = {}
    if "liked" in body:
        if not isinstance(body["liked"], bool):
            raise HttpError(400, "liked true/false olmalı")
        fields["liked"] = body["liked"]
    if "folder_id" in body:
        folder_id = body["folder_id"]
        if not isinstance(folder_id, str):
            raise HttpError(400, "Düzenleme bir şarkıya ait olmalı")
        get_folder(folder_id)
        fields["folder_id"] = folder_id
    if "title" in body:
        fields["title"] = validate_text(body, "title", 120)
    if "note" in body:
        fields["note"] = validate_text(body, "note", 2000, required=False)   # None removes it
    if "lyrics_start" in body:
        # The vocal note the lyrics start on in the score view (a wordless hummed intro comes before it).
        start = body["lyrics_start"]
        if start is not None and (not isinstance(start, int) or isinstance(start, bool) or not 0 <= start < 100000):
            raise HttpError(400, "lyrics_start 0 veya pozitif bir tam sayı olmalı")
        fields["lyrics_start"] = start or None
    if "lyrics_layout" in body:
        fields["lyrics_layout"] = validate_lyrics_layout(body["lyrics_layout"])
    if not fields:
        raise HttpError(400, "Değişiklik yok")
    # update_item, not put_item: the GPU agent writes progress to the same item concurrently.
    sets = {k: v for k, v in fields.items() if v is not None}
    removes = [k for k, v in fields.items() if v is None]
    expression = ("SET " + ", ".join(f"#{k} = :{k}" for k in sets)) if sets else ""
    if removes:
        expression += " REMOVE " + ", ".join(f"#{k}" for k in removes)
    kwargs = {"ExpressionAttributeValues": {f":{k}": v for k, v in sets.items()}} if sets else {}
    table.update_item(Key={"id": job_id}, UpdateExpression=expression.strip(),
                      ExpressionAttributeNames={f"#{k}": k for k in fields}, **kwargs)
    return public_job(get_job(job_id))


# ---------------------------------------------------------------- folders & sources

def get_folder(folder_id):
    return get_item(folder_id, FOLDERS, "Şarkı bulunamadı")


def public_folder(folder):
    return {k: folder.get(k) for k in ("id", "name", "created_at")}


def create_folder(body):
    folder = {"id": uuid.uuid4().hex, "owner": FOLDERS, "name": validate_text(body, "name", 80),
              "created_at": now() * 1000}
    table.put_item(Item=folder)
    return public_folder(folder)


def rename_folder(folder_id, body):
    folder = get_folder(folder_id)
    folder["name"] = validate_text(body, "name", 80)
    table.put_item(Item=folder)
    return public_folder(folder)


def delete_folder(folder_id):
    get_folder(folder_id)
    jobs = all_items(OWNER)
    if any(job.get("folder_id") == folder_id for job in jobs):
        raise HttpError(409, "Bu şarkıda düzenlemeler var; önce onları silin veya taşıyın")
    folder_sources = {s["id"] for s in all_items(SOURCES) if s.get("folder_id") == folder_id}
    if any(job.get("source_id") in folder_sources and job.get("status") in ("queued", "running") for job in jobs):
        raise HttpError(409, "Bu şarkının bir bestesini kullanan düzenleme sürüyor; bitmesini bekleyin")
    for source in all_items(SOURCES):
        if source.get("folder_id") == folder_id:
            for key in source_keys(source):
                s3.delete_object(Bucket=BUCKET, Key=key)
            table.delete_item(Key={"id": source["id"]})
    table.delete_item(Key={"id": folder_id})
    return {"deleted": folder_id}


def public_source(source):
    out = {k: source.get(k) for k in ("id", "folder_id", "name", "created_at", "size")}
    out["style"] = source.get("style") or ""
    out["lyrics"] = source.get("lyrics") or ""
    out["note"] = source.get("note") or ""
    out["copyright"] = bool(source.get("copyright"))
    out["url"] = presign_get(source["key"])
    out["score_edited"] = bool(source.get("score_key"))
    out["score_updated_at"] = source.get("score_updated_at")
    if source.get("score_key"):
        out["score_url"] = presign_get(source["score_key"])
    if source.get("transcript_key"):
        out["transcript_url"] = presign_get(source["transcript_key"])
    out["has_score"] = bool(source.get("score_key") or source.get("transcript_key"))
    for key in ("transcribe_status", "transcribe_message", "transcribe_error", "transcribed_at", "lyrics_layout"):
        out[key] = source.get(key)
    out["tracks"] = source.get("tracks") or []
    return out


def source_keys(source):
    return [source[k] for k in ("key", "score_key", "transcript_key") if source.get(k)]


def check_score(abc):
    """The corrected score goes to YuE2 as-is: keep it in the native SheetSage2 dialect."""
    if not isinstance(abc, str) or not abc.strip():
        raise HttpError(400, "Nota boş olamaz")
    if len(abc) > 60000:
        raise HttpError(400, "Nota en fazla 60.000 karakter olabilir")
    lines = abc.splitlines()
    if not lines or lines[0].strip() != "X:1" or not any(l.startswith("K:") for l in lines):
        raise HttpError(400, "Geçersiz nota: X:1 ve K: başlıkları gerekli")
    voices = {l.split()[1] for l in lines if l.startswith("V:") and len(l.split()) > 1}
    if voices != {"Vocal", "Ins"}:
        raise HttpError(400, "Geçersiz nota: yalnızca Vocal ve Ins sesleri olmalı")
    if any(l.startswith("w:") or l.startswith("W:") for l in lines):
        raise HttpError(400, "Nota söz satırı (w:) içermemeli; sözler ayrı gönderilir")


def save_source_score(source_id, body):
    """Keep a corrected melody for a source; covers made from it send this score to YuE2."""
    get_item(source_id, SOURCES, "Beste bulunamadı")
    abc = body.get("abc")
    check_score(abc)
    fields = {"score_key": f"sources/{source_id}.score.abc", "score_updated_at": now()}
    s3.put_object(Bucket=BUCKET, Key=fields["score_key"], Body=abc.encode("utf-8"),
                  ContentType="text/plain; charset=utf-8")
    table.update_item(Key={"id": source_id},
                      UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in fields),
                      ExpressionAttributeNames={f"#{k}": k for k in fields},
                      ExpressionAttributeValues={f":{k}": v for k, v in fields.items()})
    return public_source(get_item(source_id, SOURCES, "Beste bulunamadı"))


def request_transcription(source_id, body):
    """Queue SheetSage2 melody extraction of a source on its own, without making an arrangement.
    The score is kept on the source (transcript_key) to be edited before anything is generated."""
    source = get_item(source_id, SOURCES, "Beste bulunamadı")
    stop_after = validate_flag(body, "stop_gpu", default=False)
    if source.get("transcribe_status") in ("queued", "running"):
        return {"source": public_source(source), "gpu": describe_gpu()["state"]}
    created = now()
    task = {"id": uuid.uuid4().hex, "owner": TASKS, "kind": "transcribe", "source_id": source_id,
            "queue": "q", "status": "queued", "stage": "queued", "message": "Sırada",
            "created_at": created * 1000, "updated_at": created}
    if stop_after:
        task["stop_after"] = True
    table.put_item(Item=task)
    table.update_item(Key={"id": source_id},
                      UpdateExpression="SET transcribe_status = :q, transcribe_message = :m REMOVE transcribe_error",
                      ExpressionAttributeValues={":q": "queued", ":m": "Sırada"})
    gpu_state = ensure_gpu(quick=True)
    return {"source": public_source(get_item(source_id, SOURCES, "Beste bulunamadı")), "gpu": gpu_state}


TRACK_TEXT = {"id": 40, "instrument": 80, "text": 300}


def validate_tracks(tracks):
    """The arrangement tracks drawn in the timeline: which instrument plays how, and in which bars
    (bars = [[from, to], ...], null for the whole song). The browser turns them into style text."""
    if not isinstance(tracks, list) or len(tracks) > 16:
        raise HttpError(400, "tracks geçersiz (en fazla 16 iz)")
    out = []
    for track in tracks:
        if not isinstance(track, dict) or set(track) - {*TRACK_TEXT, "feel", "bars", "lead"}:
            raise HttpError(400, "tracks geçersiz")
        item = {}
        for key, limit in TRACK_TEXT.items():
            value = track.get(key, "")
            if not isinstance(value, str) or len(value) > limit:
                raise HttpError(400, f"iz alanı '{key}' geçersiz")
            item[key] = value.strip()
        feel = track.get("feel", [])
        if not isinstance(feel, list) or len(feel) > 12 or not all(isinstance(f, str) and 0 < len(f) <= 40 for f in feel):
            raise HttpError(400, "iz karakteri geçersiz")
        bars = track.get("bars")
        bar = lambda n: isinstance(n, int) and not isinstance(n, bool) and 0 <= n < 10000
        if bars is not None and (not isinstance(bars, list) or len(bars) > 64 or not all(
                isinstance(r, list) and len(r) == 2 and bar(r[0]) and bar(r[1]) and r[0] <= r[1] for r in bars)):
            raise HttpError(400, "iz ölçüleri geçersiz")
        lead = track.get("lead", False)
        if not isinstance(lead, bool):
            raise HttpError(400, "iz 'lead' true/false olmalı")
        item.update(feel=feel, bars=bars, lead=lead)
        if not item["instrument"]:
            raise HttpError(400, "Her izin bir enstrümanı olmalı")
        out.append(item)
    return out


def reset_source_score(source_id):
    """Back to the transcription: the saved one when there is one, else new covers extract the
    melody from the recording again."""
    source = get_item(source_id, SOURCES, "Beste bulunamadı")
    if source.get("score_key"):
        s3.delete_object(Bucket=BUCKET, Key=source["score_key"])
    table.update_item(Key={"id": source_id}, UpdateExpression="REMOVE score_key, score_updated_at")
    return public_source(get_item(source_id, SOURCES, "Beste bulunamadı"))


def update_source(source_id, body):
    """Save the style and lyrics that belong to a source song, so a new cover can start from them."""
    get_item(source_id, SOURCES, "Beste bulunamadı")
    fields = {}
    if "style" in body:
        fields["style"] = (validate_text(body, "style", 2000, required=False) or "")
    if "lyrics" in body:
        fields["lyrics"] = (validate_text(body, "lyrics", 16000, required=False) or "")
    if "name" in body:
        fields["name"] = validate_text(body, "name", 200)
    if "note" in body:
        fields["note"] = validate_text(body, "note", 2000, required=False)   # None removes it
    if "copyright" in body:
        fields["copyright"] = validate_flag(body, "copyright") or None   # the credit line; False removes it
    if "lyrics_layout" in body:
        # Which note each syllable of the source's lyrics sits on, against the source's score.
        fields["lyrics_layout"] = validate_lyrics_layout(body["lyrics_layout"])
    if "tracks" in body:
        fields["tracks"] = validate_tracks(body["tracks"]) or None
    if not fields:
        raise HttpError(400, "Değişiklik yok")
    sets = {k: v for k, v in fields.items() if v is not None}
    removes = [k for k, v in fields.items() if v is None]
    expression = ("SET " + ", ".join(f"#{k} = :{k}" for k in sets)) if sets else ""
    if removes:
        expression += " REMOVE " + ", ".join(f"#{k}" for k in removes)
    kwargs = {"ExpressionAttributeValues": {f":{k}": v for k, v in sets.items()}} if sets else {}
    table.update_item(Key={"id": source_id}, UpdateExpression=expression.strip(),
                      ExpressionAttributeNames={f"#{k}": k for k in fields}, **kwargs)
    return public_source(get_item(source_id, SOURCES, "Beste bulunamadı"))


def create_source(folder_id, body):
    """Keep an upload permanently (uploads/ expires after 30 days) as a folder's source song."""
    get_folder(folder_id)
    upload_key = validate_text(body, "upload_key", 200)
    if not re.fullmatch(r"uploads/[0-9a-f]{32}\.[a-z0-9]+", upload_key):
        raise HttpError(400, "Geçersiz dosya anahtarı")
    source_id = uuid.uuid4().hex
    key = f"sources/{source_id}.{upload_key.rsplit('.', 1)[1]}"
    head = check_upload_size(upload_key)
    s3.copy_object(Bucket=BUCKET, Key=key, CopySource={"Bucket": BUCKET, "Key": upload_key},
                   ContentType=head.get("ContentType") or "application/octet-stream", MetadataDirective="REPLACE")
    source = {"id": source_id, "owner": SOURCES, "folder_id": folder_id, "key": key,
              "name": validate_text(body, "name", 200), "size": head["ContentLength"], "created_at": now() * 1000}
    if validate_flag(body, "copyright", default=False):
        source["copyright"] = True
    table.put_item(Item=source)
    return public_source(source)


def delete_source(source_id):
    source = get_item(source_id, SOURCES, "Beste bulunamadı")
    if any(job.get("source_id") == source_id and job.get("status") in ("queued", "running") for job in all_items(OWNER)):
        raise HttpError(409, "Bu besteyi kullanan bir düzenleme sürüyor; bitmesini bekleyin veya iptal edin")
    for key in source_keys(source):
        s3.delete_object(Bucket=BUCKET, Key=key)
    table.delete_item(Key={"id": source_id})
    return {"deleted": source_id}


def library():
    return {"folders": [public_folder(f) for f in all_items(FOLDERS)],
            "sources": [public_source(s) for s in all_items(SOURCES)],
            "jobs": [public_job(j) for j in all_items(OWNER)]}


# ---------------------------------------------------------------- style sets

def public_style(item):
    return {k: item.get(k) for k in ("id", "name", "style", "created_at")}


def create_style(body):
    item = {"id": uuid.uuid4().hex, "owner": STYLES, "name": validate_text(body, "name", 80),
            "style": validate_text(body, "style", 2000), "created_at": now() * 1000}
    table.put_item(Item=item)
    return public_style(item)


def delete_style(style_id):
    get_item(style_id, STYLES, "Stil seti bulunamadı")
    table.delete_item(Key={"id": style_id})
    return {"deleted": style_id}


def status():
    gpu = describe_gpu()
    worker = get_worker()
    queue = queued_jobs()
    return {
        "gpu": gpu,
        "worker": {k: worker.get(k) for k in ("state", "message", "heartbeat_at", "last_activity_at",
                                              "boot_seconds", "load_seconds", "instance_type", "requested_type")},
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
    ("GET", r"/api/library", lambda e, m: library()),
    ("PATCH", r"/api/jobs/([0-9a-f]{32})", lambda e, m: update_job_fields(m.group(1), parse_body(e))),
    ("POST", r"/api/folders", lambda e, m: create_folder(parse_body(e))),
    ("PATCH", r"/api/folders/([0-9a-f]{32})", lambda e, m: rename_folder(m.group(1), parse_body(e))),
    ("DELETE", r"/api/folders/([0-9a-f]{32})", lambda e, m: delete_folder(m.group(1))),
    ("POST", r"/api/folders/([0-9a-f]{32})/sources", lambda e, m: create_source(m.group(1), parse_body(e))),
    ("PATCH", r"/api/sources/([0-9a-f]{32})", lambda e, m: update_source(m.group(1), parse_body(e))),
    ("DELETE", r"/api/sources/([0-9a-f]{32})", lambda e, m: delete_source(m.group(1))),
    ("PUT", r"/api/sources/([0-9a-f]{32})/score", lambda e, m: save_source_score(m.group(1), parse_body(e))),
    ("DELETE", r"/api/sources/([0-9a-f]{32})/score", lambda e, m: reset_source_score(m.group(1))),
    ("POST", r"/api/sources/([0-9a-f]{32})/transcribe", lambda e, m: request_transcription(m.group(1), parse_body(e))),
    ("GET", r"/api/styles", lambda e, m: {"styles": [public_style(i) for i in all_items(STYLES)]}),
    ("POST", r"/api/styles", lambda e, m: create_style(parse_body(e))),
    ("DELETE", r"/api/styles/([0-9a-f]{32})", lambda e, m: delete_style(m.group(1))),
    ("GET", r"/api/jobs/([0-9a-f]{32})", lambda e, m: public_job(get_job(m.group(1)))),
    ("POST", r"/api/jobs/([0-9a-f]{32})/cancel", lambda e, m: cancel_job(m.group(1))),
    ("POST", r"/api/jobs/([0-9a-f]{32})/stems", lambda e, m: request_stems(m.group(1))),
    ("DELETE", r"/api/jobs/([0-9a-f]{32})", lambda e, m: delete_job(m.group(1))),
    ("POST", r"/api/gpu/start", lambda e, m: {"gpu": ensure_gpu(quick=True)}),
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

def fail_transcription(source_id, message):
    try:
        table.update_item(Key={"id": source_id}, ConditionExpression="attribute_exists(id)",
                          UpdateExpression="SET transcribe_status = :f, transcribe_error = :e",
                          ExpressionAttributeValues={":f": "failed", ":e": message})
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


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

    for task in all_items(TASKS):
        if task.get("status") == "running" and t - int(task.get("updated_at", 0)) > STALE_RUNNING_SECONDS:
            print("failing stale task", task["id"])
            table.update_item(Key={"id": task["id"]}, UpdateExpression="SET #s = :f, finished_at = :t, updated_at = :t",
                              ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":f": "failed", ":t": t})
            if task.get("kind") == "transcribe":
                fail_transcription(task["source_id"], "Nota çıkarma zaman aşımına uğradı, tekrar deneyin")
            else:
                table.update_item(Key={"id": task["job_id"]}, UpdateExpression="SET stems_status = :f, stems_error = :e",
                                  ExpressionAttributeValues={":f": "failed", ":e": "Vokal ayırma zaman aşımına uğradı, tekrar deneyin"})

    if gpu["state"] == "stopped":
        if queue and worker.get("state") == "error":
            # The box failed and powered itself off; restarting it unattended would loop
            # (and bill) forever. The next user action (new job, stems, start) retries.
            print("jobs waiting but worker errored; not auto-starting")
        elif queue:
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
        stop_gpu("Worker yanıt vermiyor, GPU durduruldu", failed=True)
    elif not queue and not running and idle_for > (IDLE_MINUTES + 5) * 60:
        stop_gpu(f"{IDLE_MINUTES} dakikadan uzun süre boşta")
    return {"gpu": gpu["state"], "idle_for": idle_for, "queued": len(queue), "running": len(running)}
