/**
 * p17-remyral-brand: the English demo data of the deck screenshots (deck-shots.spec.ts with DECK_LOCALE=en). The spec
 * seeds the Turkish organisation; in an English run every string that goes into the database (and the text the spec
 * looks for on screen) passes through {@link translateSeed}: each Turkish phrase below is replaced by its English
 * counterpart, longest first, so slugs inside paths, ids and JSON stay consistent.
 */
const PHRASES: Readonly<Record<string, string>> = {
  // Projects and slugs (ids, repository URLs, branches, file paths). The project ids are English in both runs.
  'Yeni Müşteri Portalı': 'The new Customer Portal',
  'Müşteri Portalı': 'Customer Portal',
  'Pazarlama Sitesi': 'Marketing Site',
  'Mobil Uygulama 3.0': 'Mobile App 3.0',
  'Mobil Uygulama': 'Mobile App',
  'İçerik Stüdyosu': 'Content Studio',
  'Pazar Araştırması': 'Market Research',
  'agent/fatura-pdf': 'agent/invoice-pdf',
  'agent/oturum-suresi': 'agent/session-timeout',
  'agent/e-imza': 'agent/invoice-esign',
  'docs/yapilandirma.md': 'docs/configuration.md',
  'kampanya/sosyal-kare.png': 'campaign/social-square.png',
  'kampanya/banner-genis.png': 'campaign/banner-wide.png',
  'kampanya/': 'campaign/',

  // Jobs.
  'Fatura ekranına PDF dışa aktarma ekle': 'Add PDF export to the invoice screen',
  'Fatura listesine "PDF olarak indir" düğmesi ekle.\n\nHer fatura için şirket logosu ve KDV dökümü olsun; mevcut testler geçmeli.':
    'Add a "Download as PDF" button to the invoice list.\n\nEvery invoice gets the company logo and the VAT breakdown; the existing tests must pass.',
  'Fatura listesine "PDF olarak indir" düğmesi ekle.': 'Add a "Download as PDF" button to the invoice list.',
  'Fatura PDF dışa aktarma': 'Invoice PDF export',
  'PDF şablonuna e-imza alanı ekle': 'Add an e-signature field to the PDF template',
  'PDF faturaya e-imza alanı ekle.': 'Add an e-signature field to the PDF invoice.',
  'Ödeme sağlayıcısı SDK’sını v5’e yükselt': 'Upgrade the payment provider SDK to v5',
  'Ödeme SDK’sını v5’e yükselt ve kırılan API çağrılarını düzelt.':
    'Upgrade the payment SDK to v5 and fix the API calls that break.',
  'Oturum zaman aşımını 15 dakikadan 30 dakikaya çıkar, ayarı yapılandırılabilir yap.':
    'Raise the session timeout from 15 to 30 minutes and make it configurable.',
  'Oturum zaman aşımını 30 dakikaya çıkar': 'Raise the session timeout to 30 minutes',
  'Oturum zaman aşımı 30 dakika, yapılandırılabilir': 'Session timeout 30 minutes, configurable',
  'Kampanya açılış sayfası oluştur': 'Build the campaign landing page',
  'Ana sayfa hero görsellerini yenile': 'Refresh the home page hero images',
  'Android 15 hedef SDK güncellemesi': 'Android 15 target SDK update',
  'targetSdk 35’e çık, kenardan kenara ekran değişikliklerini uygula ve UI testlerini çalıştır.':
    'Move to targetSdk 35, apply the edge-to-edge changes and run the UI tests.',
  'Bağımlılık güvenlik güncellemeleri': 'Dependency security updates',
  'Blog için SEO meta etiketlerini düzelt': 'Fix the SEO meta tags of the blog',
  'Tüm blog sayfalarında og:image, canonical ve açıklama etiketlerini tamamla.':
    'Complete og:image, canonical and description tags on every blog page.',
  'Karanlık tema renklerini düzelt': 'Fix the dark theme colours',
  'Kullanıcı davet e-postasını çevir': 'Translate the user invitation e-mail',
  'Push bildirim izin akışını yenile': 'Rework the push notification permission flow',
  'iOS ve Android için bildirim izni isteme akışını yeniden tasarla; reddedilince tekrar sorma.':
    'Redesign the notification permission prompt for iOS and Android; do not ask again after a refusal.',
  'Sipariş geçmişine filtre ekle': 'Add filters to the order history',
  'Uygulama içi satın alma testleri': 'In-app purchase tests',
  'Fiyatlandırma sayfasını yayına al': 'Ship the pricing page',
  'Yeni fiyatlandırma sayfasını canlı ortama dağıt.': 'Deploy the new pricing page to production.',
  'Fiyatlandırma sayfasını üretim ortamına dağıt (marketing-site → production).':
    'Deploy the pricing page to production (marketing-site → production).',
  'agent/fatura-pdf dalını main’e birleştir: 5 dosya, +304 −5. 41 test ve doğrulama geçti.':
    'Merge agent/invoice-pdf into main: 5 files, +304 −5. 41 tests and verification passed.',
  'Faturalar PDF olarak indirilebilir (logo ve KDV dökümü)':
    'Invoices download as PDF (logo and VAT breakdown)',
  'agent/oturum-suresi dalını main’e birleştir: 4 dosya, +38 −9. Testler ve doğrulama geçti.':
    'Merge agent/session-timeout into main: 4 files, +38 −9. Tests and verification passed.',
  'Açılış sayfası, form ve A/B varyantı hazır; Lighthouse 98.':
    'Landing page, form and A/B variant ready; Lighthouse 98.',
  'Testler başarısız: 3 entegrasyon testi sandbox anahtarı bekliyor.':
    'Tests failed: 3 integration tests wait for a sandbox key.',
  'Sağlık kontrolü 120 sn içinde yanıt vermedi.': 'The health check did not answer within 120 s.',
  'Makine bağlantısı koptu; iş başka makinede yeniden denenecek.':
    'The machine disconnected; the job will be retried on another machine.',

  // Partial phrases the spec looks for on screen (the full sentences above are replaced first).
  'Müşteri portalında faturalar PDF': 'Customers should be able to download invoices as PDF',
  'Duyuruyu hazırlamadan önce': 'Before I draft the announcement',
  'Testler geçti': 'Tests passed',

  // Live log and agent narration.
  '› 38 blog sayfası taranıyor\n': '› Scanning 38 blog pages\n',
  '› apps/portal/src/invoices/InvoiceList.tsx güncellendi (+22 −3)\n':
    '› apps/portal/src/invoices/InvoiceList.tsx updated (+22 −3)\n',
  '› apps/portal/src/invoices/InvoicePdf.tsx oluşturuldu (+186)\n':
    '› apps/portal/src/invoices/InvoicePdf.tsx created (+186)\n',
  '› Değişiklik doğrulandı, birleştirme onayı bekleniyor\n':
    '› Change verified, waiting for the merge approval\n',
  '› Depo yapısı inceleniyor: apps/portal, packages/billing\n':
    '› Inspecting the repository: apps/portal, packages/billing\n',
  '› İkinci deneme mac-studio üzerinde\n': '› Second attempt on mac-studio\n',
  '› Lint temiz. Değişiklikler commit ediliyor…\n': '› Lint clean. Committing the changes…\n',
  '› packages/billing/src/invoice.ts okunuyor (412 satır)\n':
    '› Reading packages/billing/src/invoice.ts (412 lines)\n',
  '› Plan: InvoicePdf bileşeni + /api/invoices/:id/pdf uç noktası\n':
    '› Plan: InvoicePdf component + /api/invoices/:id/pdf endpoint\n',
  '128 test geçti': '128 tests passed',
  '41 test geçti (3 dosya)': '41 tests passed (3 files)',
  '412 satır': '412 lines',
  '+186 satır': '+186 lines',
  '+14 paket': '+14 packages',
  '3 eşleşme': '3 matches',
  'Depo yapısını inceliyorum: `apps/portal` ve `packages/billing`.':
    'Looking at the repository layout: `apps/portal` and `packages/billing`.',
  'Plan: `InvoicePdf` bileşeni, `/api/invoices/:id/pdf` uç noktası ve listeye **PDF olarak indir** düğmesi. Logo ve KDV dökümü mevcut `VatBreakdown` yardımcısından gelecek.':
    'Plan: an `InvoicePdf` component, a `/api/invoices/:id/pdf` endpoint and a **Download as PDF** button in the list. The logo and VAT breakdown come from the existing `VatBreakdown` helper.',
  'Testler geçti. Şimdi lint ve tip kontrolünü çalıştırıp değişiklikleri commit ediyorum.':
    'Tests passed. Now running lint and the type check, then committing the changes.',

  // The ops chat.
  'Müşteri portalında faturalar PDF olarak indirilebilsin. Logomuz ve KDV dökümü olsun. Uygun bir makinede başlatır mısın?':
    'Customers should be able to download invoices as PDF in the customer portal, with our logo and the VAT breakdown. Can you start it on a suitable machine?',
  '**Müşteri Portalı** için bir iş hazırladım:\n\n- `InvoicePdf` bileşeni ve `/api/invoices/:id/pdf` uç noktası\n- Şirket logosu ve KDV dökümü\n- Mevcut testler + 6 yeni test\n\n**build-01** şu an 1/4 slot kullanıyor; iş orada hemen başlayabilir. Onaylarsan başlatıyorum.':
    'I prepared a job for the **Customer Portal**:\n\n- an `InvoicePdf` component and a `/api/invoices/:id/pdf` endpoint\n- the company logo and VAT breakdown\n- the existing tests + 6 new tests\n\n**build-01** uses 1/4 slots right now; the job can start there at once. Approve it and I start it.',
  'Onayladım. Kampanya sayfası işi ne durumda?': 'Approved. How is the campaign page job doing?',
  'Kampanya açılış sayfası işi **tamamlandı** — mac-studio üzerinde 7 dakika sürdü. Özet aşağıda:':
    'The campaign landing page job **finished** — it took 7 minutes on mac-studio. Summary below:',
  'Harika. Fatura PDF’i bitince müşterilere duyuru da hazırlayalım.':
    'Great. Once the invoice PDF is done, let us prepare an announcement for customers too.',
  'Duyuruyu hazırlamadan önce birkaç şeyi netleştirelim:':
    'Before I draft the announcement, a few questions:',
  'Duyuru hangi kanallardan gitsin?': 'Which channels should the announcement go to?',
  'Duyuru tercihleri': 'Announcement preferences',
  'Metnin tonu nasıl olsun?': 'What tone should the text have?',
  'Kısa ve teknik': 'Short and technical',
  Kurumsal: 'Formal',
  Samimi: 'Friendly',
  temiz: 'clean',
  'E-posta bülteni': 'E-mail newsletter',
  'Uygulama içi bildirim': 'In-app notification',
  'Blog yazısı': 'Blog post',
  'Kullanıcıya soru soruldu': 'Asked the user a question',
  'Makine kapasitesi kontrol edildi': 'Machine capacity checked',
  'Proje ayarları okundu': 'Project settings read',

  // Deploy targets, catalog, outputs.
  'Önizleme ortamı: politika otomatik çalıştırır.': 'Preview environment: the policy runs it automatically.',
  'Üretim: onay ve doğrulama kodu.': 'Production: approval and an authenticator code.',
  'Elektronik tablolar: formüller, biçimlendirme, grafikler ve veri temizliği.':
    'Spreadsheets: formulas, formatting, charts and data cleanup.',
  'Marka renkleri ve tipografisini çıktılara uygulama.': 'Apply brand colours and typography to outputs.',
  'Özgün, üretim kalitesinde arayüzler ve bileşenler tasarlama.':
    'Design distinctive, production-grade interfaces and components.',
  'PDF dosyalarını okuma, birleştirme, form doldurma ve oluşturma.':
    'Read, merge, fill in and create PDF files.',
  'Playwright ile yerel web uygulamalarını test etme ve ekran görüntüsü alma.':
    'Test local web apps with Playwright and take screenshots.',
  'Sunum dosyaları oluşturma, düzenleme ve şablondan slayt üretme.':
    'Create and edit presentations, and build slides from a template.',
  'Word belgeleri oluşturma ve düzenleme; izlenen değişiklikler ve yorumlar.':
    'Create and edit Word documents; tracked changes and comments.',
  'Yüksek kaliteli MCP sunucuları geliştirme rehberi.': 'A guide to building high-quality MCP servers.',
  'Bahar Kampanyası': 'Spring Campaign',
  '%30 indirim · 31 Mart’a kadar': '30% off · until 31 March',
  'Faturalar artık tek tıkla PDF': 'Invoices as PDF in one click',
  'Karanlık tema · Hızlı ödeme': 'Dark theme · Fast checkout',
  'Webinar: Ajanlarla DevOps': 'Webinar: DevOps with agents',
  '12 Kasım · 14:00': '12 November · 14:00',
  'Hemen keşfet →': 'Explore now →',
  '12.400 abone': '12,400 subscribers',
  // p18-plan-mode (18): the launch plan (executing) and the campaign plan (in review).
  'Fatura PDF dışa aktarma lansmanı': 'Invoice PDF export launch',
  'Fatura PDF özelliğinin lansmanını planla: geliştirme, birleştirme onayı ve müşteri duyurusu. Önce planla, sonra adım adım ilerle.':
    'Plan the launch of the invoice PDF feature: development, the merge approval and the customer announcement. Plan first, then go step by step.',
  'Müşteriler faturalarını logolu ve KDV dökümlü PDF olarak indirebilsin; özellik testlerden geçip yayına çıksın ve müşterilere duyurulsun.':
    'Customers download their invoices as PDF with the logo and the VAT breakdown; the feature passes its tests, ships and is announced to customers.',
  'PDF işi build-01 üzerinde çalışmaya devam ediyor.': 'The PDF job keeps running on build-01.',
  'Duyuru metni İçerik Stüdyosu’nda hazırlanır.': 'The announcement is written in Content Studio.',
  'E-imza alanı için hukuk onayı gecikebilir.': 'Legal sign-off for the e-signature field may take longer.',
  'Rakiplerin fatura PDF özelliklerini karşılaştır': 'Compare the competitors’ invoice PDF features',
  'PDF içeriğini netleştir: logo, KDV dökümü, e-imza':
    'Settle the PDF content: logo, VAT breakdown, e-signature',
  'PDF içeriği netleştiriliyor': 'Settling the PDF content',
  'PDF dışa aktarma geliştiriliyor': 'Building the PDF export',
  'Birleştirme onayını ver': 'Give the merge approval',
  'Sürüm notunu ve yardım makalesini yaz': 'Write the release note and the help article',
  'Sürüm notu ve yardım makalesi yazılıyor': 'Writing the release note and the help article',
  'Kasım bültenine PDF haberini ekle': 'Add the PDF news to the November newsletter',
  'Müşteri duyurusunu yayınla': 'Publish the customer announcement',
  'Lansmanı 3 aşamada 8 maddelik bir plana döktüm. PDF işi build-01’de zaten çalışıyor, onu plana bağlayacağım. İnceleyip onaylarsan sürüm notuyla başlıyorum.':
    'I put the launch into a plan of 3 phases and 8 items. The PDF job is already running on build-01; I will link it to the plan. Review and approve it and I start with the release note.',
  'Onaylı plan v1 — sıradaki madde: Rakiplerin fatura PDF özelliklerini karşılaştır (competitor-scan). Planı sürdür.':
    'Approved plan v1 — next item: Compare the competitors’ invoice PDF features (competitor-scan). Continue the plan.',
  'Müşteri duyurusu ne zaman gitsin?': 'When should the customer announcement go out?',
  'Birleştirmeden sonraki salı': 'The Tuesday after the merge',
  'Destek ekibi hazır olur; bülten aynı haftaya denk gelir.':
    'Support is ready; the newsletter goes out the same week.',
  'Birleştirme günü': 'On the merge day',
  'En hızlı yol; destek ekibine hazırlık süresi kalmaz.': 'The fastest way; support gets no time to prepare.',
  'E-imza ile birlikte': 'Together with the e-signature',
  'Tek duyuru; lansman yaklaşık bir hafta kayar.': 'One announcement; the launch slips by about a week.',
  'Salı gönderimlerinde açılma oranı en yüksek; destek ekibi yeni soruları karşılamaya hazır olur.':
    'Tuesday sends have the highest open rate; support is ready for the new questions.',
  'Rakip analizi ve Kasım bülteni hazır. PDF dışa aktarma işi build-01’de çalışıyor; bitince birleştirme onayı sana düşecek. Bu arada sürüm notunu ve yardım makalesini yazıyorum. Duyurunun zamanı için bir karar gerekiyor, önerimi işaretledim.':
    'The competitor analysis and the November newsletter are ready. The PDF export job is running on build-01; when it finishes, the merge approval is yours. Meanwhile I am writing the release note and the help article. The announcement date needs a decision; I marked my recommendation.',
  'Kasım kampanyasını planla: açılış sayfası, sosyal medya görselleri ve bülten. Önce planla, sonra başlarız.':
    'Plan the November campaign: landing page, social media visuals and the newsletter. Plan first, then we start.',
  'Kasım kampanyasını tek akışta yayına hazırlamak: açılış sayfası, sosyal medya görselleri ve bülten aynı mesajı taşısın; gönderimler takvime bağlansın.':
    'Get the November campaign ready in one flow: the landing page, the social media visuals and the newsletter carry one message; the sends are put on the calendar.',
  'Marka renkleri ve logo İçerik Stüdyosu’ndaki kılavuzdan alınır.':
    'Brand colours and the logo come from the guide in Content Studio.',
  'Görseller haftalık içerik takvimi iş akışıyla üretilir.':
    'The visuals are made by the weekly content calendar workflow.',
  'İndirim oranı netleşmeden açılış sayfası metni yazılamaz.':
    'The landing page copy cannot be written before the discount is settled.',
  'Görsel onayı bir iş günü sürebilir.': 'Approving the visuals may take a working day.',
  'Hedef kitleyi ve ana mesajı belirle': 'Define the audience and the key message',
  'Hedef kitle ve ana mesaj belirleniyor': 'Defining the audience and the key message',
  'Rakiplerin Kasım kampanyalarını tara': 'Scan the competitors’ November campaigns',
  'Kampanya açılış sayfasını hazırla': 'Build the campaign landing page',
  'Sosyal medya görsellerini üret': 'Produce the social media visuals',
  'Kasım bülten metnini yaz': 'Write the November newsletter copy',
  'Metinleri ve görselleri onayla': 'Approve the copy and the visuals',
  'Gönderimleri yayın takvimine koy': 'Put the sends on the publishing calendar',
  'Kampanya indirimi ne kadar olsun?': 'How big should the campaign discount be?',
  '%20 indirim': '20% off',
  '%30 indirim': '30% off',
  'İlk ay ücretsiz': 'First month free',
  'Marjı korur; geçen yılın dönüşümüne yakın.': 'Keeps the margin; close to last year’s conversion.',
  'Dönüşüm artar, marj belirgin düşer.': 'Conversion goes up, the margin drops clearly.',
  'Yeni müşteri kazandırır; mevcut müşterilere etkisi yok.':
    'Wins new customers; no effect on existing ones.',
  'Geçen Kasım %20 ile dönüşüm %4,1 oldu; %30 marjı daraltır, ek dönüşüm sınırlı kalır.':
    'Last November 20% converted at 4.1%; 30% narrows the margin for little extra conversion.',
  'Öncelikli kanallar hangileri olsun?': 'Which channels come first?',
  'E-posta ve LinkedIn': 'E-mail and LinkedIn',
  'Kurumsal müşterilerin çoğu buradan geliyor.': 'Most business customers come from here.',
  'Instagram ve X': 'Instagram and X',
  'Erişim geniş, dönüşüm daha düşük.': 'Wider reach, lower conversion.',
  'Tüm kanallar eşit': 'All channels equally',
  'Portal müşterilerinin %68’i e-posta ve LinkedIn üzerinden geliyor.':
    '68% of portal customers come through e-mail and LinkedIn.',
  'Kasım kampanyası için 3 aşamalı, 7 maddelik bir plan hazırladım. Başlamadan önce iki karar gerekiyor; önerilerimi işaretledim. Onaylayınca hedef kitle çalışmasıyla başlarım.':
    'I made a plan of 3 phases and 7 items for the November campaign. Two decisions are needed before we start; I marked my recommendations. Once you approve, I start with the audience work.',
  'Kasım kampanyası': 'November campaign',
  'Görseller için geçen yılın kampanya renklerini de değerlendir.':
    'Also consider last year’s campaign colours for the visuals.',
};

/** Each phrase as written and as it appears inside JSON text (quotes and line breaks escaped), longest first. */
const PAIRS: readonly (readonly [string, string])[] = Object.entries(PHRASES)
  .flatMap(([k, v]) => {
    const jk = JSON.stringify(k).slice(1, -1);
    return jk === k ? [[k, v] as const] : [[k, v] as const, [jk, JSON.stringify(v).slice(1, -1)] as const];
  })
  .sort((a, b) => b[0].length - a[0].length);

/** The English text of a seeded Turkish string (unknown text is returned unchanged). */
export function translateSeed(s: string): string {
  let out = s;
  for (const [k, v] of PAIRS) if (out.includes(k)) out = out.split(k).join(v);
  return out;
}

/** Strings inside arrays and plain objects translated; Buffers, Dates and other values kept. */
export function translateDeep(v: unknown): unknown {
  if (typeof v === 'string') return translateSeed(v);
  if (Array.isArray(v)) return v.map(translateDeep);
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, translateDeep(x)]));
  return v;
}
