# Serkanify Studio

YuE2 ile cover / şarkı üretim stüdyosu (`studio.serkanify.com`). Mimari, maliyet ve işletim: [README.md](README.md).
Kullanıcıyla Türkçe konuş; arayüz metinleri Türkçe, kod ve commit mesajları İngilizce.

## Yapı
| Yol | Ne |
|---|---|
| `web/` | Statik arayüz, derleme yok. `app.js` form/işler, `daw.js` + `timeline.js` zaman çizelgesi editörü, `score-model.js` ABC modeli, `lyrics-layout.js` hece yerleşimi, `arrange.js` YuE2'ye gidenin derlenmesi, `align.js` |
| `api/handler.py` | Tek Lambda: API + janitor (DynamoDB `yue-jobs`, S3, EC2 başlat/durdur) |
| `worker/` | GPU kutusu: `agent.py` işleri Turbo'ya (`/v1/jobs`, `/v1/covers`) yollar; `setup.sh` sürücü/venv/model (idempotent); `turbo.env` YuE2-Turbo ayarları |
| `infra/` | Terraform (eu-central-1) |
| `tests/web.test.js` | Tarayıcısız web mantığı testleri |

## Doğrulama
```bash
node tests/web.test.js
python3 -m py_compile api/handler.py worker/agent.py worker/transcribe.py
bash -n worker/setup.sh worker/boot.sh
for f in web/*.js; do node --check "$f"; done
```
PR'larda `.github/workflows/check.yml` bunları koşar. Arayüz değişikliği tarayıcıda `python3 -m http.server 5178 -d web` ile görülür (API olmadan liste boş kalır).
Worker/GPU değişiklikleri yalnız gerçek açılışta doğrulanır: PR'da "GPU'da denenmedi" diye açıkça yaz.

## Dağıtım
`main`'e push → `.github/workflows/deploy.yml` (OIDC rolü `yue-github-deploy`): lint, `terraform apply`, web S3+CloudFront, boştaki worker'ı günceller. Yani merge = prod.
AWS kimlik bilgisi gerekmez; iş PR açmakla biter. Commit/push/merge kullanıcı isteyince.
Turbo commit'i (`TURBO_REF`) ve HF model revizyonları (`MODELS` + `turbo.env` `YUE2_*_REVISION`) sabittir; bilerek ve birlikte yükseltilir.

## YuE2 hakkında bilinmesi gerekenler
- YuE2 girdisi: tek global stil (`[Tags]`), söz metni ve isteğe bağlı ABC nota. Notada iki ses var: `Vocal` söylenir, `Ins` çalınır; akorlar yalnız `cot=full`'da. Hece→nota hizalama kanalı, fonem, ses klonlama ya da zamana bağlı talimat alanı **yok**. Söz bölümleri ABC'deki `% section` yorumlarıyla ad ve sırayla eşleşir; `[saxophone solo]` gibi etiketler yalnız ipucudur. Modele giden ABC'ye `w:` satırı koyma.
- Hece yerleşimi modeli dolaylı yönlendirir: `arrange.js` `compile` hecesiz Vocal notalarını Ins'e taşır, nota bölümlerini sözlerin yerleştiği yere göre adlandırır, söz etiketlerini düzenler, izleri İngilizce stil cümlelerine + BPM'e çevirir.
- **Editör esastır:** zaman çizelgesindeki notalar, notalara oturan heceler ve Bölüm şeridi tek doğrudur. Form metni, derlenmiş iş sözleri ya da sözlere yazılmış `[Verse]` etiketleri bunu ezemez; editörün gösterdiği, gönderilenle aynı olmalı ("farklı görünebilir" uyarısı yok). Hangi sözlerin kullanılacağı uyarılarda açıkça söylenir.
- **Eser tasarımı:** bir kaydın (ses) yanında, YuE2'ye giden adlı tasarım (ABC + söz + hece yerleşimi + izler), kayıt başına birden çok. Stil formda kalır. Metin "ses kaydından" ile "eser tasarımı «ad»" ayrımını korur; editör kayıtları tasarıma gider.
- **Kötü sonuçta önce notaya bak:** SheetSage2 transkripsiyonları sık sık on altılık kaymış başlangıçlar ve tek tük farklı ölçülü (2/4) ölçüler üretir; YuE2 notayı yazıldığı gibi okur. Stil ya da akoru suçlamadan önce payload'daki ABC'de vuruş dışı başlangıçları ve ölçü değişimlerini kontrol et. Editördeki "Notaları hizala" (`ScoreModel.tidy` = `evenMeter` + `quantize`) bunu düzeltir.
- Enstrümantal: sözler yalnız bölüm etiketleriyle gider, Vocal notaları Ins'e geçer, stil "Instrumental, no vocals …" der (YuE2'nin önerdiği yol).
- Seed yalnız aynı ağırlık + aynı çalışma ortamında aynı sonucu verir.

## Lisans
YuE2 ağırlıkları CC BY-NC 4.0 (+ yaratıcılara ek izin); ticari kullanım için M-A-P'ye danışılmalı.
