/**
 * p14-workflow-engine 14.3 (ADR-0055 K1): Projeler → Politika → "HTTP izin listesi" — workflow'ların HTTP isteği ve
 * e-posta düğümlerinin hangi adreslere gidebileceği.
 */
export default {
  title: 'HTTP izin listesi',
  sub: 'Workflow’ların HTTP isteği ve e-posta düğümleri hangi adreslere gidebilir.',
  loading: 'HTTP izin listesi',
  modeLegend: 'Kapsam',
  modes: {
    open: {
      label: 'Açık (öneri: listeyle sınırla)',
      description:
        'Herhangi bir genel adrese gidilebilir. Listedeki adresler düzenleyicide öneri olarak gösterilir.',
    },
    allowlist: {
      label: 'Yalnız listedekiler',
      description: 'HTTP ve e-posta düğümleri yalnız aşağıdaki adreslere gidebilir.',
    },
  },
  floor:
    'Yerel ağ, özel adresler, loopback, link-local ve bulut metadata adresleri (169.254.169.254 gibi) her zaman kapalıdır; istekler her zaman bir makineden çıkar, sunucudan çıkmaz.',
  openPorts:
    'Açık kapsamda 80, 443, 8080 ve 8443 dışındaki bir port yalnız listede “adres:port” olarak yazılırsa kullanılabilir.',
  hostsTitle: 'Adresler',
  hostsNone: 'Listede adres yok.',
  hostsEmptyAllowlist:
    'Liste boşken “Yalnız listedekiler” seçiliyse hiçbir HTTP veya e-posta düğümü çalışamaz.',
  hostLabel: 'Adres ekle (adres veya adres:port)',
  hostPlaceholder: 'api.ornek.example',
  add: 'Ekle',
  remove: (p: { host: string }) => `${p.host} adresini kaldır`,
  problems: {
    empty: 'Bir adres yazın.',
    format: 'Küçük harfli bir alan adı yazın (api.ornek.example veya api.ornek.example:8443).',
    ip: 'IP adresi yazılamaz; alan adı kullanın.',
    internal: 'Yerel ve iç ağ adları (localhost, .local, .internal …) her zaman kapalıdır.',
    port: 'Port 1 ile 65535 arasında olmalı.',
    duplicate: 'Bu adres zaten listede.',
    tooMany: 'En fazla 64 adres.',
  },
  save: 'Kaydet',
  stepUp: 'HTTP izin listesini değiştirmek için doğrulama kodunu girin.',
  saved: 'HTTP izin listesi kaydedildi.',
  readOnly: 'Bu listeyi yalnız proje sahipleri ve yöneticileri değiştirebilir.',
  updated: (p: { at: string; by: string }) => `Son değişiklik: ${p.at} · ${p.by}`,
};
