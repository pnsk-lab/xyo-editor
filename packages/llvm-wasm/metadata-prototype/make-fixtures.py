#!/usr/bin/env python3
"""Real SB3 fixtures for metadata byte/target tests, no generated code execution."""
import json
import sys
import zipfile
from pathlib import Path

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
hat = {"opcode":"event_whenflagclicked","next":"set","parent":None,"inputs":{},"fields":{},"shadow":False,"topLevel":True,"x":0,"y":0}
def project(variable_id, literal, sprite=False, op="data_setvariableto"):
    setblock = {"opcode":op,"next":None,"parent":"hat","inputs":{"VALUE":[1,[4,literal]]},"fields":{"VARIABLE":["v",variable_id]},"shadow":False,"topLevel":False}
    stage = {"isStage":True,"name":"Stage","variables":{variable_id:["v",0]},"lists":{},"broadcasts":{},"comments":{},"currentCostume":0,"costumes":[],"sounds":[],"volume":100,"layerOrder":0,"tempo":60,"videoTransparency":50,"videoState":"on","textToSpeechLanguage":None,"blocks":{"hat":hat,"set":setblock}}
    targets = [stage]
    if sprite:
        blocks = stage['blocks']; stage['blocks'] = {}
        targets.append({"isStage":False,"name":"Sprite","variables":{},"lists":{},"broadcasts":{},"comments":{},"blocks":blocks,"currentCostume":0,"costumes":[],"sounds":[],"volume":100,"layerOrder":1,"visible":True,"x":0,"y":0,"size":100,"direction":90,"draggable":False,"rotationStyle":"all around"})
    return {"targets":targets,"monitors":[],"extensions":[],"meta":{"semver":"3.0.0","vm":"0.2.0","agent":"metadata-fixture"}}
for name, vid, literal, sprite, op in [('simple','v','42',False,"data_setvariableto"), ('binary','v雪','A\0é𝄞',True,"data_setvariableto"), ('change','v','42',False,"data_changevariableby")]:
    with zipfile.ZipFile(out / (name+'.sb3'),'w',compression=zipfile.ZIP_DEFLATED) as f:
        f.writestr('project.json',json.dumps(project(vid,literal,sprite,op),ensure_ascii=True,separators=(',',':')))
# Straight-line chain: set 10, change by 5, change by 7 → 22.
def chain_project():
    blocks = {"hat": dict(hat)}
    prev = "hat"
    for i, (opcode, val) in enumerate([("data_setvariableto","10"),("data_changevariableby","5"),("data_changevariableby","7")]):
        bid = f"b{i}"
        blocks[bid] = {"opcode":opcode,"next":None,"parent":prev,"inputs":{"VALUE":[1,[4,val]]},"fields":{"VARIABLE":["v","v"]},"shadow":False,"topLevel":False}
        blocks[prev]["next"] = bid
        prev = bid
    stage = {"isStage":True,"name":"Stage","variables":{"v":["v",0]},"lists":{},"broadcasts":{},"comments":{},"currentCostume":0,"costumes":[],"sounds":[],"volume":100,"layerOrder":0,"tempo":60,"videoTransparency":50,"videoState":"on","textToSpeechLanguage":None,"blocks":blocks}
    return {"targets":[stage],"monitors":[],"extensions":[],"meta":{"semver":"3.0.0","vm":"0.2.0","agent":"metadata-fixture"}}
with zipfile.ZipFile(out / 'chain.sb3','w',compression=zipfile.ZIP_DEFLATED) as f:
    f.writestr('project.json',json.dumps(chain_project(),ensure_ascii=True,separators=(',',':')))
# Two variables: set v 10, set w 20.
def twovars_project():
    blocks = {"hat": dict(hat)}
    prev = "hat"
    for i, (vid, val) in enumerate([("v","10"),("w","20")]):
        bid = f"b{i}"
        blocks[bid] = {"opcode":"data_setvariableto","next":None,"parent":prev,"inputs":{"VALUE":[1,[4,val]]},"fields":{"VARIABLE":[vid,vid]},"shadow":False,"topLevel":False}
        blocks[prev]["next"] = bid
        prev = bid
    stage = {"isStage":True,"name":"Stage","variables":{"v":["v",0],"w":["w",0]},"lists":{},"broadcasts":{},"comments":{},"currentCostume":0,"costumes":[],"sounds":[],"volume":100,"layerOrder":0,"tempo":60,"videoTransparency":50,"videoState":"on","textToSpeechLanguage":None,"blocks":blocks}
    return {"targets":[stage],"monitors":[],"extensions":[],"meta":{"semver":"3.0.0","vm":"0.2.0","agent":"metadata-fixture"}}
with zipfile.ZipFile(out / 'twovars.sb3','w',compression=zipfile.ZIP_DEFLATED) as f:
    f.writestr('project.json',json.dumps(twovars_project(),ensure_ascii=True,separators=(',',':')))
def overlong_chain_project():
    blocks = {"hat": dict(hat)}
    prev = "hat"
    for i in range(9):
        bid = f"o{i}"
        blocks[bid] = {"opcode":"data_changevariableby","next":None,"parent":prev,"inputs":{"VALUE":[1,[4,"1"]]},"fields":{"VARIABLE":["v","v"]},"shadow":False,"topLevel":False}
        blocks[prev]["next"] = bid
        prev = bid
    stage = {"isStage":True,"name":"Stage","variables":{"v":["v",0]},"lists":{},"broadcasts":{},"comments":{},"currentCostume":0,"costumes":[],"sounds":[],"volume":100,"layerOrder":0,"tempo":60,"videoTransparency":50,"videoState":"on","textToSpeechLanguage":None,"blocks":blocks}
    return {"targets":[stage],"monitors":[],"extensions":[],"meta":{"semver":"3.0.0","vm":"0.2.0","agent":"metadata-fixture"}}
with zipfile.ZipFile(out / 'chain9.sb3','w',compression=zipfile.ZIP_DEFLATED) as f:
    f.writestr('project.json',json.dumps(overlong_chain_project(),ensure_ascii=True,separators=(',',':')))
# Negative fixtures: must be rejected before any codegen or large allocation.
with zipfile.ZipFile(out / 'nul-id.sb3','w',compression=zipfile.ZIP_DEFLATED) as f:
    f.writestr('project.json',json.dumps(project('v\0x','42'),ensure_ascii=True,separators=(',',':')))
with zipfile.ZipFile(out / 'nul-name.sb3','w',compression=zipfile.ZIP_DEFLATED) as f:
    doc = project('v','42')
    doc['targets'][0]['blocks']['set']['fields']['VARIABLE'] = ['v\0x','v']
    f.writestr('project.json',json.dumps(doc,ensure_ascii=True,separators=(',',':')))
# ZIP bomb: valid archive with project.json central uncompressedSize patched to
# 0x7fffffff. Extraction would resize to ~2 GiB before failing; preflight must
# reject from central-directory sizes alone without allocating.
raw = bytearray((out / 'simple.sb3').read_bytes())
eocd = raw.rfind(b'\x50\x4b\x05\x06')
count = int.from_bytes(raw[eocd+10:eocd+12],'little')
pos = int.from_bytes(raw[eocd+16:eocd+20],'little')
for _ in range(count):
    assert raw[pos:pos+4] == b'\x50\x4b\x01\x02'
    name_len = int.from_bytes(raw[pos+28:pos+30],'little')
    extra_len = int.from_bytes(raw[pos+30:pos+32],'little')
    comment_len = int.from_bytes(raw[pos+32:pos+34],'little')
    entry_name = bytes(raw[pos+46:pos+46+name_len]).decode()
    if entry_name == 'project.json':
        raw[pos+24:pos+28] = (0x7fffffff).to_bytes(4,'little')
    pos += 46 + name_len + extra_len + comment_len
(out / 'zip-bomb.sb3').write_bytes(raw)
