# p17-chat-drawer — the chat's "Ayrıntılar" drawer and the image lightbox

Owner request (2026-10-24): "ayrıntılar drawer ının içeriğini iyileştirelim. ui ve ux olarak hoş değil." and "drawerdaki
görsellere tıklandığında lightbox açılsın. yön oklarıyla sonraki, öncekine vs. gidilebilsin."

Scope: the Sohbet details drawer (`apps/web/src/diyalog/chat/DetailsPanel.tsx`, region "Sohbet ayrıntıları"), the
panel's image lightbox (`apps/web/src/diyalog/screens/outputs/Lightbox.tsx`) and a message's image attachments
(`apps/web/src/screens/chat/Attachments.tsx`). Presentation only: the same `GET /chat/assets` requests and refresh
rules, no API, permission or data change. DyDialog, `floating.ts` and `Popover.tsx` are not touched (the dialogs
motion §3.7 is being merged in parallel).

## 1. Drawer: before / after

| Area | Before | After |
| --- | --- | --- |
| Görseller | Two columns of 16:9 cropped previews, each a link opening the raw image in a new tab, the name and "Sohbette göster" under every image. | A three-column grid of square thumbnails (aspect kept inside, `object-contain`, the name as tooltip and in the button's label, lazy). A click opens the lightbox (§2); name, size, conversation, time, download and "Sohbette göster" are in the lightbox. |
| List tabs (Yıldızlı, Bağlantılar, Dosyalar, İşler) | One bordered card per item, each kind laid out differently; actions as text links stacked under the text in different places; the conversation title on its own line. | One row layout for every kind inside one bordered list (dividers, no double borders): a 32 px icon tile, the name (truncated, full text as tooltip; a starred message clamps to two lines), one meta line (parts joined with "·", truncated), the actions as aligned icon buttons at the end (Sohbette göster, İndir, Aç), 44 px on phones. |
| Meta | Files showed the master's English `detail` ("Job output", "Attachment"); job states as raw lowercase codes ("running", "confirmed"); no time on links / files / jobs. | Files: "İş çıktısı" / "Ek" (catalog, tr + en), size (`f.bytes`), time. Links: the domain as the link (full URL as tooltip, "… adresini yeni sekmede aç" label), the address without the scheme in mono, time. Jobs: kind · project · time and the state badge in the UI language. All: the short time ("14:05", "Pzt 14:05", "12 Eki 14:05") with the absolute time as tooltip; with "Tüm sohbetlerim" the conversation title joins the meta line. |
| Loading | One line "… yükleniyor…" (the list then pushed everything down). | A skeleton in the tab's shape: four rows (tile + two bars) or six square tiles, `role="status"` with the same label, the breathing pulse (off under reduced motion). |
| Empty | A grey sentence at the top left. | A centred empty state: the tab's icon in a soft circle and the same sentence (`d.empty[tab]`). |
| Header / tabs | Title, then the "Tüm sohbetlerim" checkbox, then the tab pills; the pills had no focus ring. | Title + close, the tab pills (focus ring; the chosen tab scrolls into view on narrow columns), then the scope checkbox — one fixed block with a single divider above the scrolling list. |

Unchanged: the tabs, their order and keyboard (←/→, Home, End), "Daha fazla yükle", Escape closing the drawer, the
Takipler tab (WatchesPanel), the column / sheet presence motion.

## 2. Lightbox (one component, extended)

The codebase already had one lightbox (p15-workspace-retention, used by job outputs, the job result card and kept
working files). It is extended rather than duplicated; the drawer and a message's image attachments now use it too
(the attachments had a separate DyDialog "lightbox" without navigation).

- **Content**: the image fitted to the viewport (`object-contain`), name (tooltip), a meta line (size, plus the
  caller's words: conversation · time), position "3 / 12" (polite live region), download (the drawer strips
  `inline=1` so artifacts download), "Sohbette göster" (closes, then jumps to the message), close.
- **Navigation**: ←/→ and the on-screen buttons; Home / End (first / last); a horizontal swipe ≥ 48 px that is more
  horizontal than vertical. `wrap={false}` (drawer, message attachments): the ends disable the button and the key does
  nothing; a button that becomes disabled under focus hands focus to its partner. Job outputs keep the wrap-around
  they had (default `wrap`).
- **Focus**: focus moves to the close button on open, Tab / Shift+Tab cycle inside (modal), Esc closes (captured, so
  the drawer / an enclosing dialog does not also close); on close focus goes to the thumbnail of the image last shown
  (`returnFocus`), else to the opener.
- **Loading**: thumbnails are `loading="lazy"`; the lightbox loads only the image shown plus its two neighbours
  (hidden `<img>` prefetch). Until the image has loaded a placeholder holds its place — with a known
  `width` / `height` an SVG of that aspect ratio sized like the image will be (no jump), otherwise a fixed tile; a
  failed image says "Görsel yüklenemedi." (`role="alert"`).
- **Host**: unchanged (inside an open modal `<dialog>`, else the Diyalog scope root).

## 3. Motion

Through the existing system (`motion.ts` `usePresence` / `presenceProps`, tokens of `motion-tokens.css`, a new section
in `motion.css`):

| Moment | Motion |
| --- | --- |
| Open | Backdrop fades in, the stage rises from 0.96 scale — `--dy-m-enter` (240 ms), `--dy-m-out`, from `@starting-style`. |
| Close | Fades out and shrinks to 0.96 in `--dy-m-swap` (180 ms, faster than the entry); stays mounted and `inert` until `transitionend` (usePresence). |
| Image switch | Once the new image has loaded it slides in from the side it comes from (24 px + opacity, `--dy-m-enter`); the first image of an opening only fades in. |
| Reduced motion | System or `[data-motion='reduce']`: no transition and no slide — the lightbox appears, switches and leaves at once (`usePresence` unmounts in the same commit; the JS sets no direction). |

## 4. Security review

Presentation only. Image sources are the same same-origin routes as before (`/api/chat/attachments/<uuid>/content`,
`/api/jobs/<id>/artifacts/<id>`; the asset parser keeps only console-relative URLs), served with the existing CSP +
nosniff headers; names render as text. The prefetch requests only those same URLs. External links keep
`rel="noopener noreferrer nofollow"`. No new dependency.

## 5. Tests

`apps/web/test/p17-chat-drawer.test.tsx`: the image tab is a grid (square, lazy, no list rows; a URL-less item is no
tile); the lightbox opens from a drawer thumbnail (portal host, focus inside, name, size, position, download without
`inline=1`, prefetched neighbours, loading placeholder → loaded); ←/→ and buttons, ends disabled, focus hand-over,
Home / End, Esc closes without closing the drawer and returns focus to the last image's thumbnail; focus trap; "Sohbette
göster"; swipes (left, right, short, vertical, at the end); pure helpers (`lightboxStep`, `swipeDirection`,
`mediaDownload`, `linkPath`, `mediaImages`); the placeholder's known size and the failed state; the switch direction;
the exit transition (closed + inert, unmount on `transitionend`); reduced motion (no direction, immediate close); the
empty state of every tab; skeletons in the tab's shape; the row layout (tooltip, localised source, size, download label,
link label); the fixed header + tab bar. Updated: `chat-complete.test.tsx` (a message image opens the lightbox, Esc
returns focus). Still green: `workfiles.test.tsx` (wrap-around, host), `diyalog-parity.test.tsx` (tabs, jump, Aç),
`diyalog-cmdk.test.tsx`.

UNVERIFIED: the look and the motion in a real browser (jsdom has no layout, CSS or image loading); the SVG placeholder's
sizing (replaced-element rules) and swipe feel on phones / Safari.

## 6. Rollback

Revert the p17-chat-drawer commit. No data or API involved.
