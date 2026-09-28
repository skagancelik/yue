# YuE Cover Studio

Suno/noiz.ai tarzı **cover** servisi: bir şarkı yüklersin, kendi sözlerin ve stilinle
[YuE2](https://github.com/multimodal-art-projection/YuE) yeni bir versiyonunu üretir.
AWS'de çalışır; GPU yalnızca şarkı üretilirken açıktır.

```
Tarayıcı ──► CloudFront ──► S3 (web/)                         [her zaman açık, ~$0]
                  └─ /api/* ─► Lambda (yue-api) ─► DynamoDB (yue-jobs)
                                   │  iş gelince EC2 StartInstances
                                   ▼
                GPU EC2 g6.2xlarge (L4 24GB) — normalde STOPPED
                  yue-agent ─► YuE2-Turbo (vLLM) /v1/covers
                     SheetSage2: yüklenen şarkı → melodi (ABC)
                     YuE2-3B: melodi + söz + stil → yeni şarkı (48 kHz)
                  sonuç ─► S3 outputs/ (MP3 320k + FLAC + ABC nota)
                  10 dk iş yoksa kendini kapatır
yue-janitor (5 dk'da bir): boştaki/ölü GPU'yu durdurur, bekleyen iş varsa başlatır
```

## Nasıl çalışır (cover)
1. SheetSage2 kaynak kayıttan vokal + enstrüman melodisini akor olmadan ABC notasına çevirir.
2. YuE2 bu melodiyi `cot=melody` ile, senin **stil** ve **söz** girdinle yeniden seslendirir.
3. Orijinal şarkıcının sesi klonlanmaz; melodi korunur, vokal ve düzenleme stile göre üretilir.

İyi sonuç için sözlerin bölüm sırası (`[Verse]`, `[Chorus]`…) ve hece sayısı orijinal melodiye yakın olmalı.

## Maliyet (eu-central-1)
| Kalem | Tutar |
|---|---|
| Sabit (45 GB gp3 disk + S3 + Lambda/DynamoDB/CloudFront free tier) | ≈ $5/ay |
| GPU g6.2xlarge on-demand (sadece açıkken) | ≈ $1.20/saat |
| İlk şarkı (açılış + üretim + 10 dk bekleme) | ≈ $0.35 |
| Aynı oturumda sonraki şarkı | ≈ $0.08 |

Kapasite yoksa sırasıyla `g5.2xlarge` → `g6e.xlarge` denenir. Bütçe alarmı: $30/ay (`yue-monthly`).

## Repo
| Yol | İçerik |
|---|---|
| `bootstrap/bootstrap.yaml` | Bir kez admin ile: TF state bucket, `yue-github-deploy` (OIDC) ve `yue-ops` rolleri, yetki sınırı |
| `infra/` | Terraform: VPC, GPU EC2, S3, DynamoDB, Lambda, CloudFront, budget |
| `api/handler.py` | API + janitor Lambda |
| `worker/` | GPU kutusu: `boot.sh` (her açılış), `setup.sh` (sürücü/venv/model, idempotent), `agent.py`, systemd unit'leri, `turbo.env` |
| `web/` | Arayüz (statik) |
| `.github/workflows/deploy.yml` | `main`'e push → terraform apply + web yayını + boştaki worker'ı güncelle |

Model ağırlıkları hiçbir zaman Mac'e inmez; GPU kutusu repo'yu GitHub'dan, modelleri Hugging Face'ten çeker.

## İşletim
```bash
# yerel ops profili (claude-ops kullanıcısı yue-ops rolünü üstlenir)
aws configure set profile.yue.role_arn arn:aws:iam::730335425452:role/yue-ops
aws configure set profile.yue.source_profile claude-ops
aws configure set profile.yue.region eu-central-1

aws ssm get-parameter --name /yue/passcode --with-decryption --query Parameter.Value --output text --profile yue
aws ssm start-session --target <instance-id> --profile yue      # tail -f /var/log/yue-agent.log /var/log/yue2-serve.log
```

## Lisans
Bu repo: Apache-2.0. YuE2 ağırlıkları **CC BY-NC 4.0** (+ yaratıcılar için ek izin); şirket olarak ticari kullanım için M-A-P ile iletişime geçilmeli.
