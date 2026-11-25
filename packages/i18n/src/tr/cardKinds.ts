/**
 * p18-plan-mode W4 (registry labels): the kind pill of every live card of the Diyalog console (apps/web/src/diyalog
 * registry.ts) — a chat draft card (`draft:<kind>`), a "Senden bekleyen" row (`needs:<kind>`), an operations-thread card
 * and a job-thread card — in the reader's language (they were Turkish only). Kinds whose word already lives in its own
 * feature's catalog read it from there (registry.ts).
 */
export default {
  fallback: 'Kayıt',
  draft: {
    job: 'İş taslağı',
    workflowRun: 'Workflow çalıştırma',
    workerConfig: 'Makine ayarı',
    approvalDecision: 'Onay',
    jobMessage: 'İşe mesaj',
    machineTask: 'Makine görevi',
    toolInstall: 'Araç kurulumu',
    skill: 'Yetenek',
    automation: 'Otomasyon',
    opsAction: 'Deploy',
    monitor: 'İzleme',
    jobResume: 'Devam',
    jobAction: 'İş eylemi',
    memoryChange: 'Hafıza',
    workflow: 'Workflow',
    accountAction: 'Runtime hesabı',
  },
  needs: {
    approval: 'Onay',
    automation: 'Otomasyon',
    deploy: 'Deploy',
    failed: 'Hata',
    blocked: 'Başlayamıyor',
    pairing: 'Eşleştirme',
    memoryReview: 'Hafıza',
    machine: 'Makine',
  },
  ops: {
    approval: 'Onay',
    deploy: 'Deploy',
    merge: 'Birleştirme',
    failed: 'Başarısız',
    limit: 'Limit',
    running: 'Çalışıyor',
  },
  job: {
    pause: 'Duraklatıldı',
    queue: 'Kuyrukta',
    subtasks: 'Alt işler',
    continuity: 'Oturum sürekliliği',
    verification: 'Doğrulama',
    integration: 'Entegrasyon',
    changes: 'Değişiklikler',
    deploy: 'Yayın',
    outputs: 'Çıktılar',
    previews: 'Önizleme',
    runtime: 'Runtime ve sonuç',
    memory: 'Hafıza',
  },
};
