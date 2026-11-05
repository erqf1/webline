'use strict';

// Dateigruppen für "Als Standard-App festlegen" (Webline). Vorausgewählt nur HTML und Webarchive:
// PDFs gehören meist dem Browser oder PDF-Programm, SVG eher Picline, Markdown eher Textline.
// exts = Windows (wie build/installer.nsh), mimes = Linux, utis = macOS
module.exports = {
  name: 'Webline',
  desktopId: 'webline.desktop',
  bundleId: 'app.webcase',
  progIds: ['HTML-Datei', 'HTM-Datei', 'XHTML-Datei', 'Webarchiv', 'PDF-Dokument', 'SVG-Grafik', 'Markdown-Datei'],
  groups: [
    { id: 'html', label: { en: 'HTML files', de: 'HTML-Dateien' }, exts: ['html', 'htm', 'xhtml'], mimes: ['text/html', 'application/xhtml+xml'], utis: ['public.html', 'public.xhtml'], primary: true },
    { id: 'mhtml', label: { en: 'Web archives', de: 'Webarchive' }, exts: ['mhtml', 'mht'], mimes: ['multipart/related', 'application/x-mimearchive'], utis: ['org.ietf.mhtml'], primary: true },
    { id: 'pdf', label: { en: 'PDF documents', de: 'PDF-Dokumente' }, exts: ['pdf'], mimes: ['application/pdf'], utis: ['com.adobe.pdf'], primary: false },
    { id: 'svg', label: { en: 'SVG graphics', de: 'SVG-Grafiken' }, exts: ['svg'], mimes: ['image/svg+xml'], utis: ['public.svg-image'], primary: false },
    { id: 'md', label: { en: 'Markdown', de: 'Markdown' }, exts: ['md'], mimes: ['text/markdown'], utis: ['net.daringfireball.markdown'], primary: false },
  ],
};
