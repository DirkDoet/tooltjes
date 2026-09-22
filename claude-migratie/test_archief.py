"""Tests voor archief.py op een verzonnen mini-export. Geen echte exportdata nodig.

Draaien: python -m unittest discover -s claude-migratie
"""

import contextlib
import csv
import io
import json
import os
import re
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path

import archief

P1 = "aaaaaaaa-0000-0000-0000-000000000001"
P2 = "bbbbbbbb-0000-0000-0000-000000000002"


def bericht(uuid, sender, tijd, content=None, text="", attachments=None, files=None):
    return {
        "uuid": uuid,
        "sender": sender,
        "text": text,
        "content": content or [],
        "attachments": attachments or [],
        "files": files or [],
        "created_at": tijd,
        "updated_at": tijd,
        "parent_message_uuid": None,
    }


def chat(uuid, name, created, updated, berichten):
    return {
        "uuid": uuid,
        "name": name,
        "summary": "",
        "created_at": created,
        "updated_at": updated,
        "account": {"uuid": "acc"},
        "chat_messages": berichten,
    }


CHATS = [
    # Project 1, titel met verboden tekens, alle soorten inhoud.
    chat("11111111-aaaa-0000-0000-000000000000", 'Offerte: klant/"groot"?', "2026-03-02T09:00:00Z", "2026-03-03T10:00:00Z", [
        # Bewust omgekeerd in de lijst: volgorde moet op tijdstip.
        bericht("m2", "assistant", "2026-03-02T09:01:00Z", content=[
            {"type": "thinking", "thinking": "GEHEIME-GEDACHTE"},
            {"type": "text", "text": "Hier is de offerte."},
            {"type": "tool_use", "name": "artifacts", "input": {"id": "offerte", "content": "<h1>ARTIFACT-INHOUD</h1>\n<p>tweede regel</p>"}},
            {"type": "tool_result", "name": "artifacts", "content": [{"type": "text", "text": "OK-RESULTAAT"}]},
            {"type": "token_budget", "budget": 1000},
        ]),
        bericht("m1", "human", "2026-03-02T09:00:00Z", content=[
            {"type": "injected_prompt_block", "text": "SYSTEEMBLOK"},
            {"type": "text", "text": "Maak een offerte."},
        ], attachments=[{"file_name": "prijzen.txt", "extracted_content": "PRIJSLIJST-TEKST"}],
            files=[{"file_name": "logo.png"}]),
    ]),
    # Geen project en geen titel.
    chat("22222222-bbbb-0000-0000-000000000000", "", "2026-01-15T08:00:00Z", "2026-01-15T08:05:00Z", [
        bericht("m3", "human", "2026-01-15T08:00:00Z", text="Alleen text-veld, geen content."),
    ]),
    # Twee chats in project 2 met dezelfde titel en datum.
    chat("33333333-cccc-0000-0000-000000000000", "Weekplanning", "2026-02-10T07:00:00Z", "2026-02-10T07:00:00Z", [
        bericht("m4", "human", "2026-02-10T07:00:00Z", content=[{"type": "text", "text": "Eerste"}]),
    ]),
    chat("44444444-dddd-0000-0000-000000000000", "Weekplanning", "2026-02-10T15:00:00Z", "2026-02-10T15:00:00Z", [
        bericht("m5", "human", "2026-02-10T15:00:00Z", content=[{"type": "text", "text": "Tweede"}]),
    ]),
    # Leeg: wordt overgeslagen.
    chat("55555555-eeee-0000-0000-000000000000", "Lege chat", "2026-02-11T07:00:00Z", "2026-02-11T07:00:00Z", []),
    # Heel lange titel.
    chat("66666666-ffff-0000-0000-000000000000", "L" * 300, "2026-02-12T07:00:00Z", "2026-02-12T07:00:00Z", [
        bericht("m6", "human", "2026-02-12T07:00:00Z", content=[{"type": "text", "text": "Lang"}]),
    ]),
]

PROJECTEN = [
    {"uuid": P1, "name": "Klant: De Haenen", "description": "Alles voor De Haenen.", "prompt_template": "Schrijf in jij-vorm.",
     "docs": [{"uuid": "d1", "filename": "tone-of-voice.md", "content": "TONE-INHOUD", "created_at": "2026-01-01T00:00:00Z"}],
     "creator": {}, "is_private": True, "is_starter_project": False, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
    {"uuid": P2, "name": "Intern", "description": "", "prompt_template": "", "docs": [],
     "creator": {}, "is_private": True, "is_starter_project": False, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
]

GEHEUGEN = {
    "conversations_memory": "ACCOUNT-GEHEUGEN-TEKST",
    "project_memories": {P1: "PROJECT-GEHEUGEN-TEKST"},
    "memory_files": [],
    "account_uuid": "acc",
}

KOPPELING = {
    "source": "test",
    "chat_to_project": {
        "11111111-aaaa-0000-0000-000000000000": P1,
        "33333333-cccc-0000-0000-000000000000": P2,
        "44444444-dddd-0000-0000-000000000000": P2,
    },
}


def maak_export(map_):
    with zipfile.ZipFile(map_ / "conversations-000.zip", "w") as z:
        z.writestr("conversations.json", json.dumps(CHATS))
    with zipfile.ZipFile(map_ / "projects-000.zip", "w") as z:
        for p in PROJECTEN:
            z.writestr(f"projects/{p['uuid']}.json", json.dumps(p))
    with zipfile.ZipFile(map_ / "memories-000.zip", "w") as z:
        z.writestr("memories/acc.json", json.dumps(GEHEUGEN))
    (map_ / "chat-project-koppeling.json").write_text(json.dumps(KOPPELING), encoding="utf-8")


def alle_bestanden(map_):
    return {str(p.relative_to(map_)).replace(os.sep, "/"): p.read_bytes() for p in sorted(map_.rglob("*")) if p.is_file()}


class ArchiefTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.invoer = self.tmp / "invoer"
        self.uit = self.tmp / "uit"
        self.invoer.mkdir()
        maak_export(self.invoer)
        self.uitvoer = self.draai()

    def tearDown(self):
        # Via lang_pad: gewoon opruimen struikelt over de paden uit test_lang_pad.
        shutil.rmtree(archief.lang_pad(self.tmp))

    def draai(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            archief.main([str(self.invoer), str(self.uit)])
        return buf.getvalue()

    def chats(self):
        return sorted(str(p.relative_to(self.uit / "chats")).replace(os.sep, "/") for p in (self.uit / "chats").rglob("*.md"))

    # AC-1
    def test_ontbrekend_bestand_noemt_naam(self):
        (self.invoer / "memories-000.zip").unlink()
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf), self.assertRaises(SystemExit) as fout:
            archief.main([str(self.invoer), str(self.tmp / "uit2")])
        self.assertNotEqual(fout.exception.code, 0)
        self.assertIn("memories-000.zip", buf.getvalue())

    # AC-2, AC-4
    def test_mappen_en_bestandsnamen(self):
        self.assertEqual(self.chats(), [
            "Geen project/2026-01-15 Naamloos.md",
            "Geen project/2026-02-12 " + "L" * 106 + ".md",
            "Intern/2026-02-10 Weekplanning 44444444.md",
            "Intern/2026-02-10 Weekplanning.md",
            "Klant- De Haenen/2026-03-02 Offerte- klant--groot--.md",
        ])
        for naam in self.chats():
            for deel in naam.split("/"):
                self.assertLessEqual(len(deel), 120)
                self.assertIsNone(re.search(r'[<>:"/\\|?*\x00-\x1f]', deel))

    # AC-3
    def test_inhoud_chat(self):
        tekst = (self.uit / "chats/Klant- De Haenen/2026-03-02 Offerte- klant--groot--.md").read_text(encoding="utf-8")
        for verwacht in ['# Offerte: klant/"groot"?', "2026-03-02 09:00", "2026-03-03 10:00",
                         "11111111-aaaa-0000-0000-000000000000", "Klant: De Haenen",
                         "Maak een offerte.", "Hier is de offerte.", "artifacts", "ARTIFACT-INHOUD", "OK-RESULTAAT",
                         "prijzen.txt", "PRIJSLIJST-TEKST", "logo.png", "Gebruiker", "Claude"]:
            self.assertIn(verwacht, tekst)
        for weg in ["GEHEIME-GEDACHTE", "SYSTEEMBLOK", "1000"]:
            self.assertNotIn(weg, tekst)
        # Artifact-code over meerdere regels staat leesbaar in het bestand, niet als één regel met escapes.
        self.assertIn("<h1>ARTIFACT-INHOUD</h1>\n<p>tweede regel</p>", tekst)
        # Op volgorde: gebruiker vóór Claude, ook al staat het andersom in de export.
        self.assertLess(tekst.index("Maak een offerte."), tekst.index("Hier is de offerte."))
        # Alleen het text-veld, zonder content-blokken, komt er ook in.
        naamloos = (self.uit / "chats/Geen project/2026-01-15 Naamloos.md").read_text(encoding="utf-8")
        self.assertIn("Alleen text-veld, geen content.", naamloos)

    # AC-5
    def test_index(self):
        with open(self.uit / "index.csv", encoding="utf-8-sig", newline="") as f:
            rijen = list(csv.reader(f, delimiter=";"))
        self.assertEqual(rijen[0], ["datum", "titel", "project", "berichten", "pad"])
        self.assertEqual([r[0] for r in rijen[1:]], ["2026-03-02", "2026-02-12", "2026-02-10", "2026-02-10", "2026-01-15"])
        self.assertEqual(rijen[1][1:], ['Offerte: klant/"groot"?', "Klant: De Haenen", "2",
                                        "chats/Klant- De Haenen/2026-03-02 Offerte- klant--groot--.md"])
        for r in rijen[1:]:
            self.assertTrue((self.uit / r[4]).is_file(), r[4])

    # AC-6
    def test_projecten(self):
        p1 = self.uit / "projecten/Klant- De Haenen"
        self.assertIn("Schrijf in jij-vorm.", (p1 / "instructies.md").read_text(encoding="utf-8"))
        self.assertIn("Alles voor De Haenen.", (p1 / "beschrijving.md").read_text(encoding="utf-8"))
        self.assertEqual((p1 / "bestanden/tone-of-voice.md").read_text(encoding="utf-8"), "TONE-INHOUD")
        self.assertIn("PROJECT-GEHEUGEN-TEKST", (p1 / "geheugen.md").read_text(encoding="utf-8"))
        p2 = self.uit / "projecten/Intern"
        self.assertIn("Geen instructies", (p2 / "instructies.md").read_text(encoding="utf-8"))
        self.assertTrue((p2 / "beschrijving.md").is_file())
        self.assertFalse((p2 / "geheugen.md").exists())

    # AC-7
    def test_account_geheugen(self):
        self.assertIn("ACCOUNT-GEHEUGEN-TEKST", (self.uit / "geheugen/account-geheugen.md").read_text(encoding="utf-8"))

    # AC-8
    def test_samenvatting(self):
        for regel in ["Chats geschreven: 5", "Overgeslagen (leeg): 1", "Geen project: 2", "Intern: 2",
                      "Klant: De Haenen: 1", "Projecten: 2", "Projectbestanden: 1"]:
            self.assertIn(regel, self.uitvoer)

    # AC-9
    def test_opnieuw_draaien_identiek(self):
        eerst = alle_bestanden(self.uit)
        tweede = self.draai()
        self.assertEqual(alle_bestanden(self.uit), eerst)
        self.assertEqual(tweede, self.uitvoer)

    # Windows: pad boven 260 tekens (lange titel in een diepe uitvoermap) mag niet crashen.
    def test_lang_pad(self):
        diep = self.tmp / ("d" * 100) / ("e" * 100)
        with contextlib.redirect_stdout(io.StringIO()):
            archief.main([str(self.invoer), str(diep)])
        lang = "2026-02-12 " + "L" * 106 + ".md"
        self.assertIn(lang, os.listdir(archief.lang_pad(diep / "chats" / "Geen project")))

    # AC-10
    def test_gitignore(self):
        regels = (Path(__file__).parent / ".gitignore").read_text(encoding="utf-8").splitlines()
        for nodig in ["*.zip", "chat-project-koppeling.json"]:
            self.assertIn(nodig, regels)


if __name__ == "__main__":
    unittest.main()
