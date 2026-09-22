"""Zet een Claude-export om naar een doorzoekbaar archief van markdownbestanden.

Gebruik: python archief.py <invoermap> <uitvoermap>

De invoermap bevat conversations-000.zip, projects-000.zip, memories-000.zip en
chat-project-koppeling.json. Alles werkt offline, met alleen de standaardbibliotheek.
"""

import csv
import json
import os
import re
import sys
import zipfile
from pathlib import Path

INVOER = ["conversations-000.zip", "projects-000.zip", "memories-000.zip", "chat-project-koppeling.json"]
GEEN_PROJECT = "Geen project"
MAX_NAAM = 120
AFZENDER = {"human": "Gebruiker", "assistant": "Claude"}
# Namen die Windows niet als bestands- of mapnaam accepteert, ook niet met extensie.
GERESERVEERD = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def veilige_naam(naam, max_lengte=MAX_NAAM):
    """Geldige Windows-naam: verboden tekens worden '-', geen punt of spatie aan het eind."""
    naam = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", naam)[:max_lengte].rstrip(" .")
    if naam.split(".")[0].upper() in GERESERVEERD:
        naam = naam + "-"
    return naam


def tijd(iso):
    """'2026-03-02T09:00:00.123Z' -> '2026-03-02 09:00 UTC'."""
    return iso[:10] + " " + iso[11:16] + " UTC" if iso else "onbekend"


def codeblok(tekst, taal=""):
    # Het hek is langer dan elke reeks backticks in de tekst, zodat het blok niet voortijdig sluit.
    langste = max((len(m) for m in re.findall(r"`+", tekst)), default=0)
    hek = "`" * max(3, langste + 1)
    return f"{hek}{taal}\n{tekst}\n{hek}"


def tool_result_tekst(inhoud):
    if isinstance(inhoud, str):
        return inhoud
    if isinstance(inhoud, list):
        return "\n".join(d.get("text", json.dumps(d, ensure_ascii=False)) if isinstance(d, dict) else str(d) for d in inhoud)
    return json.dumps(inhoud, ensure_ascii=False, indent=2)


def tool_use_md(blok):
    """Naam en volledige input. Tekst over meerdere regels, zoals de code van een artifact,
    krijgt een eigen codeblok: leesbaar, in plaats van één lange regel vol escapes."""
    invoer = blok.get("input")
    lang = {k: v for k, v in invoer.items() if isinstance(v, str) and "\n" in v} if isinstance(invoer, dict) else {}
    rest = {k: ("(zie hieronder)" if k in lang else v) for k, v in invoer.items()} if lang else invoer
    delen = [f"**Tool: {blok.get('name')}**", codeblok(json.dumps(rest, ensure_ascii=False, indent=2), "json")]
    for k, v in lang.items():
        delen += [f"`{k}`:", codeblok(v)]
    return "\n\n".join(delen)


def bericht_md(b):
    delen = [f"## {AFZENDER.get(b.get('sender'), b.get('sender'))} · {tijd(b.get('created_at'))}"]
    blokken = b.get("content") or []
    if not blokken and b.get("text"):
        delen.append(b["text"])
    for blok in blokken:
        soort = blok.get("type")
        if soort == "text":
            delen.append(blok.get("text", ""))
        elif soort == "tool_use":
            delen.append(tool_use_md(blok))
        elif soort == "tool_result":
            delen.append(f"**Resultaat {blok.get('name') or 'tool'}**\n\n" + codeblok(tool_result_tekst(blok.get("content"))))
        # thinking, token_budget en injected_prompt_block blijven bewust buiten het archief.
    for bijlage in b.get("attachments") or []:
        delen.append(f"**Bijlage: {bijlage.get('file_name')}**\n\n" + codeblok(bijlage.get("extracted_content") or ""))
    for bestand in b.get("files") or []:
        delen.append(f"Bestand: {bestand.get('file_name')}")
    return "\n\n".join(delen)


def chat_md(c, titel, project):
    berichten = sorted(c["chat_messages"], key=lambda b: b.get("created_at") or "")
    kop = (f"# {titel}\n\n"
           f"- Aangemaakt: {tijd(c.get('created_at'))}\n"
           f"- Laatst gewijzigd: {tijd(c.get('updated_at'))}\n"
           f"- Chat-uuid: {c['uuid']}\n"
           f"- Project: {project}\n")
    return kop + "".join("\n---\n\n" + bericht_md(b) + "\n" for b in berichten)


def lang_pad(pad):
    """Windows weigert paden boven 260 tekens, tenzij ze met \\\\?\\ beginnen. Een lange
    titel in een diep genestelde uitvoermap komt daar makkelijk boven."""
    return Path("\\\\?\\" + str(pad.resolve())) if os.name == "nt" else pad


def schrijf(pad, tekst):
    pad = lang_pad(pad)
    pad.parent.mkdir(parents=True, exist_ok=True)
    pad.write_text(tekst, encoding="utf-8", newline="\n")


def lees_json_uit_zip(zip_pad, map_in_zip):
    """Alle .json-bestanden uit een map in de ZIP, gesorteerd op naam."""
    with zipfile.ZipFile(zip_pad) as z:
        namen = sorted(n for n in z.namelist() if n.endswith(".json") and f"{map_in_zip}/" in n)
        return [json.loads(z.read(n)) for n in namen]


def unieke_naam(basis, achtervoegsel, bezet):
    """Bestandsnaam van max. 120 tekens; bij een botsing (Windows negeert hoofdletters) komt het achtervoegsel erachter."""
    naam = veilige_naam(basis, MAX_NAAM - 3) + ".md"
    if naam.lower() in bezet:
        naam = veilige_naam(basis, MAX_NAAM - 3 - len(achtervoegsel) - 1) + " " + achtervoegsel + ".md"
    bezet.add(naam.lower())
    return naam


def main(argv):
    if len(argv) != 2:
        sys.exit("Gebruik: python archief.py <invoermap> <uitvoermap>")
    invoer, uit = Path(argv[0]), Path(argv[1])
    for naam in INVOER:
        if not (invoer / naam).is_file():
            print(f"Bestand ontbreekt in {invoer}: {naam}", file=sys.stderr)
            sys.exit(1)

    with zipfile.ZipFile(invoer / "conversations-000.zip") as z:
        chats = json.loads(z.read(next(n for n in z.namelist() if n.endswith("conversations.json"))))
    projecten = lees_json_uit_zip(invoer / "projects-000.zip", "projects")
    geheugens = lees_json_uit_zip(invoer / "memories-000.zip", "memories")
    koppeling = json.loads((invoer / "chat-project-koppeling.json").read_text(encoding="utf-8"))["chat_to_project"]

    # Projecten: één map per project. Twee projecten met dezelfde naam krijgen een uuid-achtervoegsel.
    projectmap = {}  # project-uuid -> (naam, mapnaam)
    bezette_mappen = {GEEN_PROJECT.lower()}
    for p in sorted(projecten, key=lambda p: (p.get("created_at") or "", p["uuid"])):
        mapnaam = veilige_naam(p.get("name") or "Naamloos project")
        if mapnaam.lower() in bezette_mappen:
            mapnaam = veilige_naam(mapnaam, MAX_NAAM - 9) + " " + p["uuid"][:8]
        bezette_mappen.add(mapnaam.lower())
        projectmap[p["uuid"]] = (p.get("name") or "Naamloos project", mapnaam)

    project_geheugen = {}
    for g in geheugens:
        project_geheugen.update(g.get("project_memories") or {})

    aantal_bestanden = 0
    for p in projecten:
        map_ = uit / "projecten" / projectmap[p["uuid"]][1]
        schrijf(map_ / "instructies.md", p.get("prompt_template") or "Geen instructies\n")
        schrijf(map_ / "beschrijving.md", p.get("description") or "Geen beschrijving\n")
        for doc in p.get("docs") or []:
            schrijf(map_ / "bestanden" / veilige_naam(doc.get("filename") or doc.get("uuid")), doc.get("content") or "")
            aantal_bestanden += 1
        if project_geheugen.get(p["uuid"]):
            schrijf(map_ / "geheugen.md", project_geheugen[p["uuid"]])

    schrijf(uit / "geheugen" / "account-geheugen.md",
            "\n\n".join(g.get("conversations_memory") or "" for g in geheugens) or "Geen accountgeheugen\n")

    # Chats: oudste eerst, zodat bij een botsing altijd dezelfde chat het achtervoegsel krijgt.
    index, per_project, overgeslagen = [], {}, 0
    bezet = {}  # mapnaam -> set van bestandsnamen (kleine letters)
    for c in sorted(chats, key=lambda c: (c.get("created_at") or "", c["uuid"])):
        if not c.get("chat_messages"):
            overgeslagen += 1
            continue
        project, mapnaam = projectmap.get(koppeling.get(c["uuid"]), (GEEN_PROJECT, GEEN_PROJECT))
        titel = c.get("name") or "Naamloos"
        datum = (c.get("created_at") or "")[:10]
        bestandsnaam = unieke_naam(f"{datum} {titel}", c["uuid"][:8], bezet.setdefault(mapnaam, set()))
        schrijf(uit / "chats" / mapnaam / bestandsnaam, chat_md(c, titel, project))
        per_project[project] = per_project.get(project, 0) + 1
        index.append((c.get("created_at") or "", c["uuid"], datum, titel, project, len(c["chat_messages"]),
                      f"chats/{mapnaam}/{bestandsnaam}"))

    # Puntkomma en BOM: zo opent Excel met Nederlandse instellingen de kolommen meteen goed.
    index.sort(key=lambda r: (r[0], r[1]), reverse=True)
    lang_pad(uit).mkdir(parents=True, exist_ok=True)
    with open(lang_pad(uit / "index.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["datum", "titel", "project", "berichten", "pad"])
        w.writerows(r[2:] for r in index)

    print(f"Chats geschreven: {len(index)}")
    print(f"Overgeslagen (leeg): {overgeslagen}")
    print("Per project:")
    for project in sorted(per_project, key=lambda p: (p != GEEN_PROJECT, p.lower())):
        print(f"  {project}: {per_project[project]}")
    print(f"Projecten: {len(projecten)}")
    print(f"Projectbestanden: {aantal_bestanden}")


if __name__ == "__main__":
    main(sys.argv[1:])
