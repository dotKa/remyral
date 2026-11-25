/**
 * p16-assistant-admin: Sohbetten yönetim — kullanıcılar, üyelikler, makineler, sürüm yayılımı, bildirimler,
 * entegrasyonlar. Asistanın yönetim kartları (ayar kartı, hedef "admin") ve tek seferlik geçici parola. Değerler
 * `{ad}` yer tutucularıyla (`fill`) doldurulur.
 */
export default {
  card: {
    kind: 'Yönetim',
    action: 'İşlem',
    user: 'Kullanıcı',
    role: 'Rol',
    previousRole: 'Önceki rol',
    project: 'Proje',
    machine: 'Makine',
    channel: 'Kanal',
    version: 'Sürüm',
    rollout: 'Yayılım',
    rolloutValue: '{version} · makinelerin %{percent} kadarı',
    previous: 'Önceki',
    provider: 'Bağlantı',
    kinds: 'Bildirim türleri',
    email: 'E-posta adresi',
    webhook: 'Webhook',
    changed: 'değişir',
    removed: 'kaldırılır',
    reason: 'Gerekçe',
    force: 'Çalışan işleri beklemeden',
    privileged: 'Yetkili yardımcıyı da çalıştır',
    destructive:
      'Geri alması zor bir işlem: güvenlik politikası sohbetten yıkıcı yönetime izin vermedikçe yalnızca bu kartla onaylanır.',
    reveal: 'Onaylayınca geçici parola yalnızca bu kartta bir kez gösterilir; sohbete hiç yazılmaz.',
    ops: {
      'user.invite': 'Kullanıcı davet et',
      'user.set_role': 'Hesap rolünü değiştir',
      'user.enable': 'Hesabı yeniden aç',
      'user.disable': 'Hesabı devre dışı bırak',
      'member.add': 'Projeye üye ekle / rolünü değiştir',
      'member.remove': 'Proje üyeliğini kaldır',
      'machine.approve': 'Makine eşleşmesini onayla',
      'machine.reject': 'Makine eşleşmesini reddet',
      'machine.revoke': 'Makinenin erişimini iptal et',
      'machine.rotate_key': 'Makine anahtarını yenile',
      // p19-chat-machine-admin
      'machine.prepare': 'Makinenin sandbox’ını hazırla',
      'release.set_rollout': 'Sürüm yayılımını ayarla',
      'release.pause': 'Sürüm yayılımını duraklat',
      'release.rollback_machine': 'Makineyi eski sürüme döndür',
      'notifications.update': 'Bildirim tercihlerim',
      'integration.check': 'Entegrasyonu sına',
      // p18-assistant-gaps
      'workflow.cancel_run': 'Workflow çalıştırmasını iptal et',
      'workflow.decide_node': 'Workflow onay adımına karar ver',
      'backup.run': 'Şimdi yedek al',
      'backup.drill': 'Geri yükleme tatbikatı başlat',
      'backup.restore': 'Veritabanını yedekten geri yükle',
      'host.upgrade': 'Remyral’ı güncelle',
      'template.from_job': 'İşi şablon olarak kaydet',
      'monitor.update': 'Uptime monitörünü değiştir',
      'deploy.health_recheck': 'Sağlık kontrolünü yeniden çalıştır',
      'job.answer_question': 'İşin sorusunu yanıtla',
      'cost_brake.lift': 'Maliyet frenini geçici kaldır',
      'cost_brake.end_lift': 'Fren kaldırmayı bitir',
      'cost_brake.project_ceiling': 'Proje harcama tavanı',
      // p18-leftovers
      'budget.create': 'Yeni bütçe',
      'budget.update': 'Bütçeyi değiştir',
      'budget.delete': 'Bütçeyi sil',
      // p18-project-bootstrap
      'project.network': 'Projenin ağ erişimi',
      'project.machines': 'Projenin makineleri',
      // p19-ide W4
      'code.request_changes': 'Değişiklik iste',
    },
    /** p18-assistant-gaps: the card's kind pill by area (instead of "Yönetim"). */
    groups: {
      workflow: 'Workflow',
      backup: 'Yedek',
      host: 'Güncelleme',
      template: 'Şablon',
      monitor: 'Uptime',
      deploy: 'Deploy',
      job: 'İş sorusu',
      cost_brake: 'Maliyet freni',
      budget: 'Bütçe',
      project: 'Proje kurulumu',
      code: 'Kod incelemesi',
    },
    /** p18-assistant-gaps: the facts of the new cards. */
    gaps: {
      workflow: 'Workflow',
      node: 'Adım',
      step: 'Adımın başlığı',
      decision: 'Karar',
      approve: 'Onayla',
      deny: 'Reddet',
      backup: 'Yedek',
      newest: 'en yenisi',
      template: 'Şablon adı',
      prompt: 'İstem (başı)',
      monitor: 'Monitör',
      changes: 'Değişenler',
      url: 'Adres',
      answers: 'Yanıt',
      scope: 'Kapsam',
      global: 'tümü',
      hours: 'Saat',
      ceiling: 'Tavan (USD)',
      ceilingValue: 'günlük {daily} · aylık {monthly}',
      release: 'Sürüm notu',
      breaking: 'Bu sürümde uyumsuz değişiklikler var:',
      // p18-leftovers: budget cards.
      budget: 'Bütçe',
      budgetValue: '{limit} {metric} / {window} · {scope}',
      budgetFrom: 'Şu an',
      budgetOff: 'kapalı',
      loosens:
        'Bu değişiklik bütçeyi gevşetir (tutulmadan önce daha çok iş çalışır). Sen açıkça istemedikçe yalnızca bu kartla onaylanır.',
      always:
        'Canlı veritabanı bu yedekle değiştirilir; sonradan yazılan her şey kaybolur. Bu işlem hiçbir zaman doğrudan yapılmaz: yalnızca bu kartla, güncel bir doğrulama koduyla onaylanır.',
    },
  },
  /** p18-project-bootstrap: the project setup cards (network access, machines). */
  setup: {
    network: 'Ağ erişimi',
    networkNow: 'Şu an',
    modes: {
      none: 'Kapalı (yalnızca model API’leri)',
      allowlist: 'Yalnızca izin verilenler',
      web: 'Tüm açık web (443)',
    },
    reach: '{mode} · {list}',
    nothing: 'liste yok',
    opens:
      'Bu değişiklik projenin işlerine ağ erişimi açar. Sen açıkça istemedikçe yalnızca bu kartla onaylanır.',
    assign: 'Atanacak makineler',
    unassign: 'Çıkarılacak makineler',
    preferred: 'Tercih edilen makineler',
    preferredNone: 'tercih yok',
    preferredNote:
      'Projenin her işi önce bu makineleri dener; bu makineler çalıştıramazsa uygun başka bir makine çalıştırır.',
  },
  password: {
    title: 'Geçici parola',
    save: 'Bu parolayı şimdi kopyalayıp yeni kullanıcıya güvenli bir yoldan ilet: bir daha gösterilmez. İlk girişte kimlik doğrulayıcı kurulur ve parola değiştirilir.',
    copy: 'Parolayı kopyala',
    user: '{username} için',
  },
  settings: {
    chatDestructive: 'Sohbet yıkıcı yönetim işlemlerini kartsız yapabilir',
    chatDestructiveHint:
      'Kapalıyken (önerilen) asistan bir hesabı devre dışı bırakmayı ya da bir makinenin erişimini iptal etmeyi, sen açıkça istesen de “Otomatik mod”da bile yalnızca kartla önerir. Kod isteyen olaylar her durumda kod ister.',
    chatMachineAdmin: 'Makinede söylediğimi yap',
    chatMachineAdminHint:
      'Açıkken sohbette kendi mesajınla bir makinede iş istediğinde (paket kur, servis ayarla, sandbox’ı hazırla) asistan bunu hemen yapar: başlattığı makine yönetimi işinin yönetici (root / Administrator) komutları ayrıca onay beklemeden politikayla geçer, yetkili hazırlık için taze kod gerekmez. Her komut kayda geçer. Yönetici rolü ve makinede açık makine yönetimi yine gerekir; sistemin kendi yazdığı mesajlar (takip, plan devamı) bunu yalnızca “Hedefe bağlı yetki” açıkken ve o hedefin kapsamında kullanır.',
    goalGrants: 'Hedefe bağlı yetki',
    goalGrantsHint:
      'Açıkken sohbette kendi mesajınla hemen yaptırdığın bir iş (aynı makine, proje ve işlem türü) 6 saat boyunca o sohbetin devam turlarına da geçer: otonom onaylı planın ya da takibin devamı aynı işi yeniden karta veya onaya düşürmeden sürdürür. Kapsam dışı bir adım tek nedenle kartta durur. Kod isteyen olaylar, roller, makinenin kendi makine yönetimi anahtarı ve her zaman kart olan işlemler (yedek geri yükleme vb.) değişmez. Kapatınca ya da sohbetin yetkisini geri alınca hemen biter. Her miras kayda geçer.',
    autoExtendTime: 'Süreyi kendiliğinden uzat',
    autoExtendTimeHint:
      'Açıkken bir işin süresi azaldığında iş hala ilerliyorsa (son 10 dakikada bir şey yaptıysa ve kimseyi beklemiyorsa) süre kendiliğinden uzatılır: sınırın yarısı kadar, en az 30 dk, en çok iş süresi üst sınırına kadar; bir iş en çok 3 kez. Her uzatma kayda geçer ve işin sohbetine “Süreyi otomatik uzattım” notu düşer. Takılmış görünen işler uzatılmaz; onlarda karar senin.',
  },
};
