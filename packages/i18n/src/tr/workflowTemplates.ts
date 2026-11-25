/**
 * p14-workflow-engine 14.5 (ADR-0055): hazır workflow şablonları — her şablonun adı, açıklaması, düğüm etiketleri,
 * workflow'un içine yazılan metinler (onay başlıkları, bildirimler, rapor) ve sihirbazın sorduğu yer tutucuların
 * etiketleri (anahtar: şablon kimliği). Arayüz metinleri `workflowGallery`'de.
 */

export default {
  categories: {
    marketing: 'Pazarlama',
    content: 'İçerik üretimi',
    video: 'Video üretimi',
  },
  items: {
    'marketing-content-calendar': {
      name: 'Haftalık içerik takvimi',
      description:
        'Her hafta markan için kanal başına gönderi taslakları yazar, bir operatörün onayına sunar ve onaylanan gönderileri sosyal medya API’ne zamanlanmış olarak gönderir; sonunda e-postayla bir rapor yollar. Sosyal medya API adresi, isteğe bağlı bir http-auth kimlik bilgisi ve rapor için SMTP kimlik bilgisi gerekir.',
      nodes: {
        weekly: 'Her hafta',
        manual: 'Elle başlat',
        calendar: 'Takvimi yaz (yapay zeka)',
        review: 'Takvimi onayla',
        publish: 'Her gönderi için',
        post: 'Sosyal API’ye gönder',
        posted: 'Gönderi sonucu',
        report: 'Raporu hazırla',
        mail: 'Raporu e-postayla gönder',
        denied: 'Reddedildi bildirimi',
      },
      content: {
        approvalTitle: 'Haftalık içerik takvimi onay bekliyor',
        reportSubject: 'Haftalık içerik takvimi raporu',
        reportIntro: 'Bu haftanın gönderileri sosyal medya API’ne gönderildi:',
        deniedTitle: 'Haftalık içerik takvimi reddedildi',
      },
      placeholders: {
        brand: { label: 'Marka', hint: 'Gönderilerin yazılacağı marka veya ürün adı.' },
        channels: { label: 'Kanallar', hint: 'Virgülle ayrılmış kanallar, örnek: linkedin, x, instagram.' },
        language: { label: 'Dil', hint: 'Gönderilerin dili (tr veya en).' },
        schedule_cron: {
          label: 'Zamanlama (cron, UTC)',
          hint: 'Takvimin ne zaman yazılacağı. Varsayılan: her pazartesi 06:00 UTC.',
        },
        social_origin: {
          label: 'Sosyal medya API adresi',
          hint: 'Gönderileri zamanlayan servisin adresi (örnek: https://api.buffer.com). Yalnız genel adresler.',
        },
        social_path: { label: 'Gönderi yolu', hint: 'Gönderi oluşturan uç nokta, örnek: /v1/posts.' },
        social_credential: {
          label: 'Sosyal medya API kimlik bilgisi',
          hint: 'İsteğe bağlı. Kasadaki bir “http-auth” kimlik bilgisi; yalnız bu adrese bağlıysa eklenir (Bearer).',
        },
        smtp_provider: { label: 'E-posta sağlayıcısı', hint: 'Raporu gönderecek SMTP sağlayıcısı.' },
        smtp_username: { label: 'SMTP kullanıcı adı', hint: 'Genellikle gönderen e-posta adresi.' },
        smtp_credential: {
          label: 'SMTP kimlik bilgisi',
          hint: 'Kasadaki “smtp” türünde, sağlayıcının sunucusuna bağlı parola.',
        },
        mail_from: { label: 'Gönderen adres', hint: 'Raporun gönderen adresi.' },
        report_to: { label: 'Rapor alıcısı', hint: 'Haftalık raporun gideceği adres.' },
        runtime: {
          label: 'Yapay zeka runtime’ı',
          hint: 'Yapay zeka adımlarının varsayılan runtime’ı (Claude Code, Codex, Pi, OpenCode).',
        },
      },
    },
    'marketing-lead-intake': {
      name: 'Potansiyel müşteri karşılama',
      description:
        'Web formundan gelen başvuruyu imzalı bir webhook ile alır, bir zenginleştirme API’siyle şirket ve unvan bilgisini ekler, kod düğümüyle 0–100 arası puanlar ve puana göre CRM’e “sıcak” ya da “beslenecek” olarak yazar; sıcak başvurularda operatörlere bildirim gider. Zenginleştirme başarısız olsa da başvuru kaydedilir. Zenginleştirme ve CRM API adresleri gerekir.',
      nodes: {
        lead: 'Form webhook’u',
        enrich: 'Bilgiyi zenginleştir',
        enriched: 'Zenginleştirme sonucu',
        score: 'Puanla (kod)',
        hot: 'Puan eşiği geçti mi?',
        crm_hot: 'CRM’e sıcak olarak yaz',
        alert: 'Operatörlere bildir',
        crm_nurture: 'CRM’e beslenecek olarak yaz',
      },
      content: {
        hotTitle: 'Sıcak potansiyel müşteri',
        hotBody: 'Puan:',
      },
      placeholders: {
        enrich_origin: {
          label: 'Zenginleştirme API adresi',
          hint: 'E-posta adresinden kişi ve şirket bilgisi döndüren servis (örnek: https://person.clearbit.com).',
        },
        enrich_path: {
          label: 'Zenginleştirme yolu',
          hint: 'Sorgu yapılan uç nokta; e-posta “email” parametresiyle gider.',
        },
        enrich_credential: {
          label: 'Zenginleştirme API kimlik bilgisi',
          hint: 'İsteğe bağlı. Kasadaki bir “http-auth” kimlik bilgisi; yalnız bu adrese bağlıysa eklenir (Bearer).',
        },
        crm_origin: { label: 'CRM API adresi', hint: 'Başvuruların yazılacağı CRM’in adresi.' },
        crm_path: { label: 'CRM kayıt yolu', hint: 'Yeni başvuru oluşturan uç nokta, örnek: /v1/leads.' },
        crm_credential: {
          label: 'CRM kimlik bilgisi',
          hint: 'İsteğe bağlı. Kasadaki bir “http-auth” kimlik bilgisi; yalnız bu adrese bağlıysa eklenir (Bearer).',
        },
        threshold: { label: 'Sıcak eşiği', hint: 'Bu puan ve üstü sıcak sayılır (1–100, varsayılan 60).' },
        runtime: {
          label: 'Yapay zeka runtime’ı',
          hint: 'Yapay zeka adımlarının varsayılan runtime’ı (Claude Code, Codex, Pi, OpenCode).',
        },
      },
    },
    'content-production': {
      name: 'İçerik üretimi (araştırmadan yayına)',
      description:
        'Bir konu için arama API’siyle araştırma yapar, yapay zeka ile özet, taslak plan ve makale yazar; yapay zeka incelemesinden sonra bir operatör onaylar. Onaylanan metin kod düğümünde SEO kontrollerinden geçer ve içerik yönetim sistemine (CMS) HTTP ile taslak ya da yayın olarak gönderilir. Arama ve CMS API adresleri gerekir.',
      nodes: {
        start: 'Elle başlat',
        research: 'Konuyu ara',
        brief: 'Araştırma özeti (yapay zeka)',
        outline: 'Taslak plan (yapay zeka)',
        draft: 'Makaleyi yaz (yapay zeka)',
        review: 'Yapay zeka incelemesi',
        approve: 'Editör onayı',
        seo: 'SEO kontrolleri (kod)',
        seo_ok: 'SEO uygun mu?',
        publish: 'CMS’e gönder',
        published: 'Gönderildi bildirimi',
        seo_fix: 'SEO düzeltmeleri bildirimi',
        rejected: 'Reddedildi bildirimi',
      },
      content: {
        approvalTitle: 'Makale onay bekliyor',
        aiScore: 'Yapay zeka incelemesi',
        publishedTitle: 'Makale CMS’e gönderildi',
        seoTitle: 'Makale SEO kontrollerinden geçmedi',
        rejectedTitle: 'Makale reddedildi',
      },
      placeholders: {
        research_origin: {
          label: 'Arama API adresi',
          hint: 'Konu için sonuç döndüren arama servisi (örnek: https://api.search.brave.com).',
        },
        research_path: {
          label: 'Arama yolu',
          hint: 'Sorgunun gittiği uç nokta; arama “q” parametresiyle gider.',
        },
        research_credential: {
          label: 'Arama API kimlik bilgisi',
          hint: 'İsteğe bağlı. Kasadaki bir “http-auth” kimlik bilgisi; yalnız bu adrese bağlıysa eklenir (Bearer).',
        },
        cms_origin: { label: 'CMS API adresi', hint: 'Makalenin gönderileceği içerik yönetim sistemi.' },
        cms_path: { label: 'CMS gönderi yolu', hint: 'Yeni yazı oluşturan uç nokta, örnek: /api/posts.' },
        cms_credential: {
          label: 'CMS kimlik bilgisi',
          hint: 'İsteğe bağlı. Kasadaki bir “http-auth” kimlik bilgisi; yalnız bu adrese bağlıysa eklenir (Bearer).',
        },
        cms_status: {
          label: 'CMS durumu',
          hint: 'draft: taslak olarak kaydeder; publish: doğrudan yayınlar.',
        },
        runtime: {
          label: 'Yapay zeka runtime’ı',
          hint: 'Yapay zeka adımlarının varsayılan runtime’ı (Claude Code, Codex, Pi, OpenCode).',
        },
      },
    },
    'video-production': {
      name: 'Video üretimi',
      description:
        'Bir brief’ten yapay zeka ile senaryo ve sahne listesi çıkarır, her sahne için seslendirme ve görseli sağlayıcı API’lerinden ister, videoyu konteynerli bir makinede ffmpeg ile birleştirir. Bir operatör videoyu onaylayınca video platformuna yükler, yayınlar ve haber verir. Seslendirme, görsel ve video platformu API adresleri ile konteyner motoru olan bir makine gerekir.',
      nodes: {
        start: 'Elle başlat',
        script: 'Senaryo (yapay zeka)',
        storyboard: 'Sahne listesi (yapay zeka)',
        shots: 'Her sahne için',
        voice: 'Seslendirme iste',
        asset: 'Görsel iste',
        shot_ready: 'Sahne hazır',
        shot: 'Sahne sonucu',
        render: 'Videoyu birleştir (ffmpeg)',
        review: 'Videoyu onayla',
        create_upload: 'Yükleme oluştur',
        upload: 'Videoyu yükle',
        publish: 'Videoyu yayınla',
        published: 'Yayınlandı bildirimi',
        rejected: 'Reddedildi bildirimi',
      },
      content: {
        reviewTitle: 'Video onay bekliyor',
        publishedTitle: 'Video yayınlandı',
        rejectedTitle: 'Video reddedildi',
      },
      placeholders: {
        tts_origin: {
          label: 'Seslendirme API adresi',
          hint: 'Metinden ses üreten servis; yanıtında “url” alanı olmalı (örnek: https://api.elevenlabs.io).',
        },
        tts_path: { label: 'Seslendirme yolu', hint: 'Ses üreten uç nokta, örnek: /v1/speech.' },
        tts_credential: {
          label: 'Seslendirme API kimlik bilgisi',
          hint: 'İsteğe bağlı. Kasadaki bir “http-auth” kimlik bilgisi; yalnız bu adrese bağlıysa eklenir (Bearer).',
        },
        asset_origin: {
          label: 'Görsel API adresi',
          hint: 'Sahne görseli veya klibi üreten servis; yanıtında “url” alanı olmalı.',
        },
        asset_path: { label: 'Görsel yolu', hint: 'Görsel üreten uç nokta, örnek: /v1/images.' },
        asset_credential: {
          label: 'Görsel API kimlik bilgisi',
          hint: 'İsteğe bağlı. Kasadaki bir “http-auth” kimlik bilgisi; yalnız bu adrese bağlıysa eklenir (Bearer).',
        },
        video_origin: { label: 'Video platformu API adresi', hint: 'Videonun yükleneceği platform.' },
        video_upload_path: {
          label: 'Yükleme oluşturma yolu',
          hint: 'İmzalı yükleme adresi (body.uploadUrl) ve kimlik (body.id) döndüren uç nokta.',
        },
        video_publish_path: { label: 'Yayın yolu', hint: 'Yüklenen videoyu yayınlayan uç nokta.' },
        video_credential: {
          label: 'Video platformu kimlik bilgisi',
          hint: 'İsteğe bağlı. Kasadaki bir “http-auth” kimlik bilgisi; yalnız bu adrese bağlıysa eklenir (Bearer).',
        },
        visibility: { label: 'Görünürlük', hint: 'private, unlisted veya public.' },
        runtime: {
          label: 'Yapay zeka runtime’ı',
          hint: 'Yapay zeka adımlarının varsayılan runtime’ı (Claude Code, Codex, Pi, OpenCode).',
        },
      },
    },
  },
};
