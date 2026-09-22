"""Pakt de eigen claude.ai-skills in als zip per skill en schrijft een migratiechecklist.

Gebruik: python skills.py <uitvoermap>

Leest de lokaal gesyncte skills onder %APPDATA%\\Claude. Werkt offline, met alleen de
standaardbibliotheek. Uploaden naar Teams gebeurt met de hand, via de checklist.
"""

import json
import os
import sys
import zipfile
from pathlib import Path

CONNECTORS = [
    "Linear", "Zapier", "Gmail", "Microsoft 365 (Outlook/SharePoint/Teams)", "Google Calendar", "Google Drive",
    "Figma", "Meta Ads", *(f"WordPress/Novamira (site {i} van 4)" for i in range(1, 5)), "Elementor",
    # Staan in geen enkele config, dus hier met de hand.
    "Google Search Console, GA4, Google Ads (eigen MCP's in C:\\mcp)",
]


def zoek_manifest(zoekmap):
    """manifest.json onder skills-plugin/*/*/. Staan er meerdere, dan telt de laatst bijgewerkte."""
    gevonden = sorted(zoekmap.glob("*/*/manifest.json"), key=lambda p: p.stat().st_mtime)
    return gevonden[-1] if gevonden else None


def pak_in(skillmap, zip_pad):
    """Zip met de map <naam>/ erin, zoals Teams een skill verwacht. Vaste volgorde, dus herhaalbaar."""
    zip_pad.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_pad, "w", zipfile.ZIP_DEFLATED) as z:
        for pad in sorted(p for p in skillmap.rglob("*") if p.is_file()):
            z.write(pad, f"{skillmap.name}/{pad.relative_to(skillmap).as_posix()}")


def mcp_servers(config_pad):
    """{servernaam: [bronnen]} uit mcpServers bovenin en uit projects.<pad>.mcpServers."""
    if not config_pad.is_file():
        return {}
    config = json.loads(config_pad.read_text(encoding="utf-8"))
    gevonden = {}
    for naam in config.get("mcpServers") or {}:
        gevonden.setdefault(naam, []).append("algemeen")
    for project, instellingen in sorted((config.get("projects") or {}).items()):
        for naam in (instellingen or {}).get("mcpServers") or {}:
            gevonden.setdefault(naam, []).append(f"project `{project}`")
    return gevonden


def reden_niet_inpakken(skillmap):
    """Waarom een skill niet ingepakt kan worden, of None als hij compleet is."""
    if not skillmap.is_dir():
        return "map ontbreekt"
    if not (skillmap / "SKILL.md").is_file():
        return "SKILL.md ontbreekt"
    return None


def checklist(ingepakt, niet_ingepakt, servers_per_bestand):
    r = ["# Migratie naar Claude Teams", ""]
    if niet_ingepakt:
        r += ["> **Let op: deze eigen skills zijn niet ingepakt en moeten met de hand worden overgezet.**", ">"]
        r += [f"> - {naam}: {reden}" for naam, reden in niet_ingepakt]
        r += [""]
    r += ["## (a) Skills uploaden als organisatie-skill in Teams", "",
          "Settings > Capabilities > Skills, één zip per keer.", ""]
    r += [f"- [ ] Skill uploaden: `skills/{naam}.zip`" for naam in ingepakt] or ["Geen eigen skills gevonden."]
    r += ["", "## (b) Projecten opnieuw aanmaken en delen met collega's", "",
          "- [ ] Projecten opnieuw aanmaken en delen; instructies, beschrijving en bestanden staan in `projecten/`"]
    r += ["", "## (c) Geheugen importeren", "",
          "- [ ] Geheugen importeren in Teams via Settings (officiële import), bron `geheugen/account-geheugen.md`"]
    r += ["", "## (d) Connectors opnieuw koppelen", ""]
    r += [f"- [ ] {c}" for c in CONNECTORS]
    r += ["", "## (e) Lokale MCP-servers", ""]
    for pad, servers in servers_per_bestand:
        r += [f"Uit `{pad}`:", ""]
        r += [f"- [ ] MCP-server `{s}` (bron: {', '.join(servers[s])}): blijft werken, alleen opnieuw inloggen"
              for s in sorted(servers)] or ["Geen MCP-servers gevonden (bestand ontbreekt of heeft geen `mcpServers`)."]
        r += [""]
    r += ["", "## (f) Cowork-taak", "", "- [ ] Cowork-taak ochtendbriefing (08:45) opnieuw aanmaken"]
    r += ["", "## (g) Opnieuw inloggen", "", "- [ ] Claude Code en desktop-app opnieuw inloggen met werkaccount"]
    r += ["", "## (h) Als laatste", "", "- [ ] Pas als alles hierboven af is: persoonlijk abonnement opzeggen", ""]
    return "\n".join(r)


def main(argv):
    if len(argv) != 1:
        sys.exit("Gebruik: python skills.py <uitvoermap>")
    uit = Path(argv[0])
    claude = Path(os.environ["APPDATA"]) / "Claude"
    zoekmap = claude / "local-agent-mode-sessions" / "skills-plugin"
    manifest = zoek_manifest(zoekmap)
    if not manifest:
        print(f"Geen manifest.json gevonden onder {zoekmap}\\*\\*\\", file=sys.stderr)
        sys.exit(1)

    skills = json.loads(manifest.read_text(encoding="utf-8"))["skills"]
    overgeslagen = sorted(s["name"] for s in skills if s.get("creatorType") != "user")
    ingepakt, niet_ingepakt = [], []
    for naam in sorted(s["name"] for s in skills if s.get("creatorType") == "user"):
        zip_pad = uit / "skills" / f"{naam}.zip"
        reden = reden_niet_inpakken(manifest.parent / "skills" / naam)
        if reden:
            niet_ingepakt.append((naam, reden))
            zip_pad.unlink(missing_ok=True)  # geen oude zip laten staan van een eerdere run
        else:
            pak_in(manifest.parent / "skills" / naam, zip_pad)
            ingepakt.append(naam)

    # De desktop-app en Claude Code bewaren hun MCP-servers elk in een eigen bestand.
    configs = [claude / "claude_desktop_config.json", Path(os.environ.get("USERPROFILE") or Path.home()) / ".claude.json"]
    uit.mkdir(parents=True, exist_ok=True)
    (uit / "CHECKLIST.md").write_text(checklist(ingepakt, niet_ingepakt, [(c, mcp_servers(c)) for c in configs]),
                                      encoding="utf-8", newline="\n")

    print(f"Manifest: {manifest}")
    print(f"Ingepakt: {len(ingepakt)} ({', '.join(ingepakt)})")
    print(f"Overgeslagen: {len(overgeslagen)} ({', '.join(overgeslagen)})")
    print(f"Checklist: {uit / 'CHECKLIST.md'}")
    if niet_ingepakt:
        print(f"Niet ingepakt: {len(niet_ingepakt)} ({', '.join(f'{n}: {r}' for n, r in niet_ingepakt)})", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv[1:])
