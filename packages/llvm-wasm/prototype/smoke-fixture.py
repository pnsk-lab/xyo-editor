#!/usr/bin/env python3
"""Create small real SB3 fixtures for the isolated IR prototype, not mocks."""
import json
import sys
import zipfile
from pathlib import Path

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
base = {"isStage": True, "name": "Stage", "variables": {"v": ["v", 0]},
        "lists": {}, "broadcasts": {}, "comments": {}, "currentCostume": 0,
        "costumes": [], "sounds": [], "volume": 100, "layerOrder": 0,
        "tempo": 60, "videoTransparency": 50, "videoState": "on", "textToSpeechLanguage": None}
hat = {"opcode": "event_whenflagclicked", "next": "set", "parent": None,
       "inputs": {}, "fields": {}, "shadow": False, "topLevel": True, "x": 0, "y": 0}
setblock = {"opcode": "data_setvariableto", "next": None, "parent": "hat",
            "inputs": {"VALUE": [1, [4, "42"]]}, "fields": {"VARIABLE": ["v", "v"]},
            "shadow": False, "topLevel": False}
for name in ("valid", "wait", "two-hats", "change", "chain", "twovars"):
    blocks = {"hat": dict(hat), "set": dict(setblock)}
    if name == "change":
        blocks["set"] = {"opcode": "data_changevariableby", "next": None, "parent": "hat", "inputs": {"VALUE": [1, [4, "42"]]}, "fields": {"VARIABLE": ["v", "v"]}, "shadow": False, "topLevel": False}
    if name == "chain":
        blocks = {"hat": dict(hat)}
        prev = "hat"
        for i, (opcode, val) in enumerate([("data_setvariableto", "10"), ("data_changevariableby", "5"), ("data_changevariableby", "7")]):
            bid = f"b{i}"
            blocks[bid] = {"opcode": opcode, "next": None, "parent": prev, "inputs": {"VALUE": [1, [4, val]]}, "fields": {"VARIABLE": ["v", "v"]}, "shadow": False, "topLevel": False}
            blocks[prev]["next"] = bid
            prev = bid
    if name == "twovars":
        blocks = {"hat": dict(hat)}
        prev = "hat"
        for i, (vid, val) in enumerate([("v", "10"), ("w", "20")]):
            bid = f"b{i}"
            blocks[bid] = {"opcode": "data_setvariableto", "next": None, "parent": prev, "inputs": {"VALUE": [1, [4, val]]}, "fields": {"VARIABLE": [vid, vid]}, "shadow": False, "topLevel": False}
            blocks[prev]["next"] = bid
            prev = bid
        base = dict(base, variables={"v": ["v", 0], "w": ["w", 0]})
    if name == "wait":
        blocks["set"] = {"opcode": "control_wait", "next": None, "parent": "hat", "inputs": {"DURATION": [1, [4, "1"]]}, "fields": {}, "shadow": False, "topLevel": False}
    if name == "two-hats":
        blocks["hat2"] = {**hat, "next": None, "x": 20}
    project = {"targets": [{**base, "blocks": blocks}], "monitors": [], "extensions": [],
               "meta": {"semver": "3.0.0", "vm": "0.2.0", "agent": "prototype-smoke"}}
    with zipfile.ZipFile(out / (name + ".sb3"), "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.json", json.dumps(project, separators=(",", ":")))
long_blocks = {"hat": dict(hat)}
_long_prev = "hat"
for _i in range(9):
    _bid = f"o{_i}"
    long_blocks[_bid] = {"opcode": "data_changevariableby", "next": None, "parent": _long_prev, "inputs": {"VALUE": [1, [4, "1"]]}, "fields": {"VARIABLE": ["v", "v"]}, "shadow": False, "topLevel": False}
    long_blocks[_long_prev]["next"] = _bid
    _long_prev = _bid
long_project = {"targets": [{**base, "blocks": long_blocks}], "monitors": [], "extensions": [],
                "meta": {"semver": "3.0.0", "vm": "0.2.0", "agent": "prototype-smoke"}}
with zipfile.ZipFile(out / "chain9.sb3", "w", compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr("project.json", json.dumps(long_project, separators=(",", ":")))


def _project_with(vid, name):
    blocks = {"hat": dict(hat),
              "set": {**dict(setblock), "fields": {"VARIABLE": [name, vid]}}}
    stage = dict(base)
    stage["variables"] = {vid: [name, 0]}
    return {"targets": [{**stage, "blocks": blocks}], "monitors": [],
            "extensions": [],
            "meta": {"semver": "3.0.0", "vm": "0.2.0", "agent": "prototype-smoke"}}


# Negative fixtures for the host-side admission gates (must fail in rh_create
# before any large allocation or codegen).
with zipfile.ZipFile(out / "nul-id.sb3", "w",
                     compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr("project.json", json.dumps(_project_with("v\0x", "v"),
                                          ensure_ascii=True, separators=(",", ":")))
with zipfile.ZipFile(out / "nul-name.sb3", "w",
                     compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr("project.json", json.dumps(_project_with("v", "v\0x"),
                                          ensure_ascii=True, separators=(",", ":")))
# ZIP bomb: valid archive with project.json central uncompressedSize patched
# to 0x7fffffff. Extraction would resize to ~2 GiB; preflight must reject.
raw = bytearray((out / "valid.sb3").read_bytes())
eocd = raw.rfind(b"\x50\x4b\x05\x06")
count = int.from_bytes(raw[eocd + 10:eocd + 12], "little")
assert count == 1, count
pos = int.from_bytes(raw[eocd + 16:eocd + 20], "little")
assert raw[pos:pos + 4] == b"\x50\x4b\x01\x02"
raw[pos + 24:pos + 28] = (0x7FFFFFFF).to_bytes(4, "little")
(out / "zip-bomb.sb3").write_bytes(raw)
