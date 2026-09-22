"""Tests voor skills.py met een nep-manifest en nep-skillmappen. Geen echte data nodig.

Draaien: python -m unittest discover -s claude-migratie
"""

import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import skills


def maak_appdata(root, mcp_servers=None):
    """Zelfde indeling als op de pc: skills-plugin/<id>/<id>/manifest.json met skills/<naam>/ ernaast."""
    basis = root / "Claude" / "local-agent-mode-sessions" / "skills-plugin" / "org-1" / "acc-1"
    (basis / "skills").mkdir(parents=True)
    manifest = {"lastUpdated": "2026-09-21T00:00:00Z", "skills": [
        {"skillId": "s1", "name": "dirk-doet-dna", "description": "", "creatorType": "user", "updatedAt": "", "enabled": True, "backingPluginId": "p"},
        {"skillId": "s2", "name": "dirkdoet-cms", "description": "", "creatorType": "user", "updatedAt": "", "enabled": True, "backingPluginId": "p"},
        {"skillId": "s3", "name": "docx", "description": "", "creatorType": "anthropic", "updatedAt": "", "enabled": True, "backingPluginId": "p"},
    ]}
    (basis / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    for naam in ["dirk-doet-dna", "dirkdoet-cms", "docx"]:
        (basis / "skills" / naam).mkdir()
        (basis / "skills" / naam / "SKILL.md").write_text(f"# {naam}", encoding="utf-8")
    (basis / "skills" / "dirk-doet-dna" / "references").mkdir()
    (basis / "skills" / "dirk-doet-dna" / "references" / "tone.md").write_text("TONE", encoding="utf-8")
    config = {"preferences": {}}
    if mcp_servers is not None:
        config["mcpServers"] = mcp_servers
    (root / "Claude" / "claude_desktop_config.json").write_text(json.dumps(config), encoding="utf-8")


class SkillsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.appdata = self.tmp / "appdata"
        self.uit = self.tmp / "uit"
        self.home = self.tmp / "home"
        self.home.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def draai(self):
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"APPDATA": str(self.appdata), "USERPROFILE": str(self.home)}), contextlib.redirect_stdout(buf):
            skills.main([str(self.uit)])
        return buf.getvalue()

    # AC-1, AC-2
    def test_alleen_user_skills_ingepakt_met_mapstructuur(self):
        maak_appdata(self.appdata, {"gsc": {"command": "node"}})
        uitvoer = self.draai()
        self.assertEqual(sorted(p.name for p in (self.uit / "skills").iterdir()), ["dirk-doet-dna.zip", "dirkdoet-cms.zip"])
        with zipfile.ZipFile(self.uit / "skills" / "dirk-doet-dna.zip") as z:
            self.assertEqual(sorted(z.namelist()), ["dirk-doet-dna/SKILL.md", "dirk-doet-dna/references/tone.md"])
            self.assertEqual(z.read("dirk-doet-dna/references/tone.md"), b"TONE")
        with zipfile.ZipFile(self.uit / "skills" / "dirkdoet-cms.zip") as z:
            self.assertEqual(z.namelist(), ["dirkdoet-cms/SKILL.md"])
        self.assertIn("Ingepakt: 2 (dirk-doet-dna, dirkdoet-cms)", uitvoer)
        self.assertIn("Overgeslagen: 1 (docx)", uitvoer)

    # Review #95: eigen skill zonder map of zonder SKILL.md wordt niet ingepakt, wel gemeld, exitcode 2.
    def test_skill_zonder_map_of_skill_md(self):
        maak_appdata(self.appdata, None)
        basis = next(self.appdata.rglob("manifest.json")).parent
        manifest = json.loads((basis / "manifest.json").read_text(encoding="utf-8"))
        manifest["skills"] += [
            {"skillId": "s4", "name": "zonder-map", "creatorType": "user"},
            {"skillId": "s5", "name": "zonder-skill-md", "creatorType": "user"},
        ]
        (basis / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (basis / "skills" / "zonder-skill-md" / "references").mkdir(parents=True)
        (basis / "skills" / "zonder-skill-md" / "references" / "x.md").write_text("x", encoding="utf-8")
        # Een zip van een eerdere, nog wel complete run mag niet blijven staan.
        (self.uit / "skills").mkdir(parents=True)
        (self.uit / "skills" / "zonder-skill-md.zip").write_bytes(b"oud")

        uit, fout = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"APPDATA": str(self.appdata), "USERPROFILE": str(self.home)}),                 contextlib.redirect_stdout(uit), contextlib.redirect_stderr(fout), self.assertRaises(SystemExit) as exit_:
            skills.main([str(self.uit)])
        self.assertEqual(exit_.exception.code, 2)
        self.assertEqual(sorted(p.name for p in (self.uit / "skills").iterdir()), ["dirk-doet-dna.zip", "dirkdoet-cms.zip"])
        self.assertIn("Ingepakt: 2 (dirk-doet-dna, dirkdoet-cms)", uit.getvalue())
        self.assertIn("Niet ingepakt: 2 (zonder-map: map ontbreekt, zonder-skill-md: SKILL.md ontbreekt)", fout.getvalue())
        tekst = (self.uit / "CHECKLIST.md").read_text(encoding="utf-8")
        waarschuwing = tekst.index("> **Let op")
        self.assertLess(waarschuwing, tekst.index("## (a)"))
        self.assertIn("> - zonder-map: map ontbreekt", tekst)
        self.assertIn("> - zonder-skill-md: SKILL.md ontbreekt", tekst)
        self.assertNotIn("`skills/zonder-map.zip`", tekst)
        self.assertNotIn("`skills/zonder-skill-md.zip`", tekst)

    # Complete skills: geen waarschuwingsblok.
    def test_geen_waarschuwing_als_alles_compleet(self):
        maak_appdata(self.appdata, None)
        self.draai()
        self.assertNotIn("Let op", (self.uit / "CHECKLIST.md").read_text(encoding="utf-8"))

    # AC-3
    def test_manifest_ontbreekt(self):
        self.appdata.mkdir()
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"APPDATA": str(self.appdata), "USERPROFILE": str(self.home)}), contextlib.redirect_stderr(buf), \
                self.assertRaises(SystemExit) as fout:
            skills.main([str(self.uit)])
        self.assertEqual(fout.exception.code, 1)
        self.assertIn(str(self.appdata / "Claude" / "local-agent-mode-sessions" / "skills-plugin"), buf.getvalue())

    # AC-4
    def test_checklist(self):
        maak_appdata(self.appdata, {"gsc": {"command": "node"}, "ga4": {"command": "node"}})
        # Claude Code: servers bovenin en per project; een naam kan op beide plekken staan.
        (self.home / ".claude.json").write_text(json.dumps({
            "mcpServers": {"elementor-blink-hostess": {"command": "npx"}},
            "projects": {"C:\p1": {"mcpServers": {"linear": {}, "elementor-blink-hostess": {}}}, "C:\p2": {}},
        }), encoding="utf-8")
        self.draai()
        tekst = (self.uit / "CHECKLIST.md").read_text(encoding="utf-8")
        skillregels = [r for r in tekst.splitlines() if r.startswith("- [ ] Skill ")]
        self.assertEqual(skillregels, ["- [ ] Skill uploaden: `skills/dirk-doet-dna.zip`",
                                       "- [ ] Skill uploaden: `skills/dirkdoet-cms.zip`"])
        self.assertNotIn("docx", tekst)
        for verwacht in ["projecten/", "geheugen/account-geheugen.md", "Linear", "Zapier", "Gmail",
                         "Microsoft 365 (Outlook/SharePoint/Teams)", "Google Calendar", "Google Drive", "Figma",
                         "Meta Ads", "Elementor", "08:45", "werkaccount", "abonnement opzeggen"]:
            self.assertIn(verwacht, tekst)
        self.assertEqual(tekst.count("WordPress/Novamira"), 4)
        self.assertIn("- [ ] Google Search Console, GA4, Google Ads (eigen MCP's in C:\mcp)", tekst)
        mcp = [r for r in tekst.splitlines() if "blijft werken, alleen opnieuw inloggen" in r]
        self.assertEqual(mcp, [
            "- [ ] MCP-server `ga4` (bron: algemeen): blijft werken, alleen opnieuw inloggen",
            "- [ ] MCP-server `gsc` (bron: algemeen): blijft werken, alleen opnieuw inloggen",
            "- [ ] MCP-server `elementor-blink-hostess` (bron: algemeen, project `C:\p1`): blijft werken, alleen opnieuw inloggen",
            "- [ ] MCP-server `linear` (bron: project `C:\p1`): blijft werken, alleen opnieuw inloggen",
        ])
        # Per bestand staat erbij waar het vandaan komt.
        self.assertLess(tekst.index(f"Uit `{self.appdata / 'Claude' / 'claude_desktop_config.json'}`:"), tekst.index("`ga4`"))
        self.assertLess(tekst.index(f"Uit `{self.home / '.claude.json'}`:"), tekst.index("`linear`"))
        for sectie in "abcdefgh":
            self.assertIn(f"## ({sectie})", tekst)
        # Alles is afvinkbaar.
        for regel in tekst.splitlines():
            if regel.startswith("- "):
                self.assertTrue(regel.startswith("- [ ] "), regel)

    # AC-4 (e): desktop-config zonder mcpServers (zoals op de pc van Albert) en geen .claude.json.
    def test_checklist_zonder_mcp_servers(self):
        maak_appdata(self.appdata, None)
        self.draai()
        tekst = (self.uit / "CHECKLIST.md").read_text(encoding="utf-8")
        self.assertEqual(tekst.count("Geen MCP-servers gevonden (bestand ontbreekt of heeft geen `mcpServers`)."), 2)
        self.assertNotIn("MCP-server `", tekst)

    # Opnieuw draaien geeft hetzelfde resultaat.
    def test_opnieuw_draaien_identiek(self):
        maak_appdata(self.appdata, {"gsc": {"command": "node"}})
        eerst = self.draai()
        bytes_ = {p.name: p.read_bytes() for p in (self.uit / "skills").iterdir()}
        self.assertEqual(self.draai(), eerst)
        self.assertEqual({p.name: p.read_bytes() for p in (self.uit / "skills").iterdir()}, bytes_)

    # AC-5
    def test_gitignore(self):
        regels = (Path(__file__).parent / ".gitignore").read_text(encoding="utf-8").splitlines()
        for nodig in ["*", "!skills.py", "!test_skills.py"]:
            self.assertIn(nodig, regels)
        self.assertNotIn("!CHECKLIST.md", regels)


if __name__ == "__main__":
    unittest.main()
