ERGEBNIS CLOUD-SESSION webline-113

1. Aufgabe und Status
   Webline 1.13.0: eigenes Symbol für Web-Programme, Fix für Scroll-Seiten, F6 = Adresse vorübergehend ändern,
   Desktop-Symbol nur bei der Erst-Installation. Auf Wunsch des Nutzers zusätzlich: Passwörter merken und
   ausfüllen (Autofill).
   Alles fertig, getestet und nach main gemergt. NICHT erledigt: Tag v1.13.0. Ein Tag-Push aus der
   Cloud-Session wird vom Git-Proxy abgelehnt (HTTP 403), der Push auf main ging. Deshalb gibt es noch
   keinen Release.

2. Branch, Commits, PR, Tag, CI
   - Branch webline-symbol-f6, per Fast-Forward nach main gemergt (main = 62ae68f, dazu dieser Bericht)
   - Commits: df20547 (Symbol, F6, Scroll, Installer, CI), f2cedc9 (Mac-Testfix), 62ae68f (Passwort-Autofill),
     danach nur der Bericht
   - PR: keiner (main direkt gemergt). Tag v1.13.0: NICHT gepusht (403).
   - CI-Workflow "Test" Run 3 (44644754360) auf 62ae68f: alle 4 Jobs grün
     (Test Windows/Linux/macOS + Installer-Durchlauf unter Windows).
   - Release-Workflow lief noch nicht, weil der Tag fehlt.

3. Was geändert wurde
   - Symbole (src/appicons.js, main.js): Bild auswählen, Symbol der Webseite (link rel=icon/apple-touch-icon/
     Manifest/favicon.ico) oder Standard. Gespeichert als 256er-PNG + ICO (16-256 px) in userData/icons,
     neuer Dateiname je Änderung wegen des Symbol-Caches von Windows. Erscheint auf Kachel, Fenster-Symbol
     und Desktop-Verknüpfung, eine vorhandene Verknüpfung wird aktualisiert. Dekodieren im versteckten
     Sandbox-Fenster mit Canvas, damit alle Formate auf allen Systemen gehen.
   - Scroll-Fix: Programmfenster wird vor loadURL in Arbeitsbereich-Größe angelegt und sofort maximiert.
     Die Seite misst beim Laden schon die Endgröße.
   - Navigation: www/Subdomains zählen als eigene Seite (siteOf, mit Ausnahmen für geteilte Hosts wie
     github.io). Bei einer fremden Seite öffnet sich der Browser, das Fenster geht genau einen Eintrag zurück
     (verzögert, damit die Scroll-Position bleibt). Schleifenschutz bei Skript-Weiterleitungen.
     Zoom und Smooth-Scrolling geprüft: kein Handlungsbedarf.
   - F6: eigene WebContentsView (src/urlbar/) statt Shadow-DOM in der Seite (robust gegen CSP, Trusted Types
     und Tasten-Handler der Seite). Gilt nur im Fenster, nur in Web-Programmen. Zurück mit Alt+←
     (Mac: ⌘[), Maus-Zurück/-Vor, Wischen. Kürzel änderbar. Bugfix: programShortcut kannte editUrl/back nicht.
   - Passwort-Autofill (neu):
     - src/autofill/preload.js (isolierte Welt, nur Web-Programme): Beim Absenden (Formular, Enter,
       Anmelde-Knopf) fragt Webline "Passwort speichern / aktualisieren?" mit Speichern / Nicht jetzt /
       Nie für diese Seite.
     - Klick ins Benutzer- oder Passwortfeld zeigt die gespeicherten Konten (geschlossenes Shadow-DOM).
       Erst ein echter Klick oder ↓+Enter füllt aus (isTrusted), nie ungefragt.
     - src/passwords.js: verschlüsselt mit Electron safeStorage (Windows DPAPI, macOS Schlüsselbund,
       Linux libsecret/KWallet). Linux ohne Schlüsselbund (basic_text): es wird nichts gespeichert,
       mit Hinweis. Gespeichert je Programm und Seite.
     - Programm und Origin bestimmt der Hauptprozess (nur Hauptframe des eigenen Fensters).
     - Einstellungen → Passwörter: Schalter "Speichern anbieten", Liste, Löschen, "Wieder erlauben".
   - Installer: createDesktopShortcut false. Eigene Logik in build/installer.nsh: Symbol nur bei der
     Erst-Installation, Update lässt es stehen, Umstieg von 1.12 stellt es wieder her, echtes
     Deinstallieren entfernt es.
   - CI: .github/workflows/test.yml (neu). Release-Workflow nimmt Notizen aus release-notes/v1.13.0.md
     (Deutsch, Link auf https://mert.win/html/changelog.html).
   - README, Version 1.13.0, website-updates/changelog-1.13.0.html + 5 WebP-Bilder in website-updates/img/.

4. Getestet
   - tools/test-web.js unsichtbar, lokal und in der CI auf Windows/Linux/macOS grün. Abgedeckt:
     - Symbol: per Mini-Server (link rel=icon, favicon.ico als ICO), SVG-Datei, kaputtes Bild, Abbrechen,
       Zurücksetzen, Aufräumen, ICO gültig, Verknüpfung zeigt das ICO (Windows) bzw. PNG (.desktop), Kachel.
     - Navigation: Zurück per Taste und Maus, Weiterleitung ohne www -> www bleibt im Fenster,
       innerHeight beim ersten Laden = Endgröße ohne resize, fremder Link geht in den Browser und die
       Scroll-Position bleibt, Schleifenschutz.
     - F6: öffnen, Esc, fremde Adresse, Links darauf, gespeicherte Adresse unverändert, zurück.
     - Passwörter: Speichern, Datei ohne Klartext, Ausfüllen per Tastatur und Maus, keine erneute Frage,
       Aktualisieren, andere Seite bekommt nichts, "Nie", Abschalten, Löschen, künstliche Tastendrücke der
       Seite füllen nichts aus, Seite sieht kein require/ipc.
   - Installer-Job (Windows CI): Erst-Installation, Update, Setup von Hand, gelöschtes Symbol bleibt weg,
     Deinstallieren, Neu-Installation, Umstieg von 1.12 (von Hand und per --updated): grün.
   - NICHT getestet:
     - echte Schlüsselbund-Verschlüsselung: Im Test ersetzt, weil Linux-CI keinen Schlüsselbund hat und
       macOS nachfragen würde. Lokal meldet Linux/Xvfb korrekt "nicht verfügbar".
     - sichtbares Maximieren unter Windows/macOS, echter Dateidialog, Taskleisten-Symbol,
       echter Auto-Update-Lauf.
     - Autofill in iframes und bei mehrstufigen Logins (Benutzer und Passwort auf getrennten Seiten):
       nicht unterstützt.

5. Offene Punkte / was der Nutzer tun muss
   - Tag setzen (startet den Release-Workflow):
       git fetch origin && git tag v1.13.0 62ae68f && git push origin v1.13.0
     Danach prüfen, ob im Release liegen: Setup .exe, portable .exe, .deb, .pacman, .tar.gz, 2x Mac-zip,
     latest*.yml.
   - Website: website-updates/changelog-1.13.0.html in mert.win/html/changelog.html einfügen und die Bilder
     aus website-updates/img/ hochladen.
   - Hinweis: Beim Umstieg von 1.12 per Setup von Hand springt das Desktop-Symbol EINMAL (das alte
     Uninstall löscht es, 1.13 legt es neu an). Ab 1.13 passiert das nicht mehr.
   - Hinweis: Unter Linux ohne GNOME-Schlüsselbund/KWallet bietet Webline das Speichern von Passwörtern
     nicht an.

6. Nächste Schritte für die Haupt-Session
   - Tag v1.13.0 auf 62ae68f pushen (siehe 5).
   - Release-Workflow "Build & Release" beobachten (3 Builds + Veröffentlichen), Assets prüfen.
   - Auto-Update einer 1.12-Installation auf 1.13 einmal echt ausprobieren (Desktop-Symbol bleibt,
     wo es ist).
