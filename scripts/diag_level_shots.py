"""Diag: GIS level drill shots (country -> province -> farm) via exposed window.__map."""
import json, base64, time, os
import urllib.request
os.environ['NO_PROXY'] = '127.0.0.1,localhost'
os.environ['no_proxy'] = '127.0.0.1,localhost'
import websocket

ver = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version"))
ws = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=40)
_id = [0]


def send(method, params=None, sid=None):
    _id[0] += 1
    msg = {"id": _id[0], "method": method, "params": params or {}}
    if sid:
        msg["sessionId"] = sid
    ws.send(json.dumps(msg))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == _id[0]:
            return r.get("result", {})


def ev(expr, sid):
    r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True}, sid=sid)
    return r.get("result", {}).get("value")


def shot(name, sid):
    r = send("Page.captureScreenshot", {"format": "png"}, sid=sid)
    open(name, "wb").write(base64.b64decode(r["data"]))
    print("saved", name)


t = send("Target.createTarget", {"url": "http://127.0.0.1:5173/gis"})["targetId"]
s = send("Target.attachToTarget", {"targetId": t, "flatten": True})["sessionId"]
time.sleep(12)

shot("/tmp/gis_country.png", s)

# province: click 河北 center via map.project + real CDP mouse event
pt = ev("(() => { const m = window.__map; const p = m.project([115.5, 38.4]); return JSON.stringify({x: p.x, y: p.y}); })()", s)
print("hebei px:", pt)
pos = json.loads(pt)
send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": int(pos["x"]), "y": int(pos["y"]), "button": "left", "clickCount": 1}, sid=s)
send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": int(pos["x"]), "y": int(pos["y"]), "button": "left", "clickCount": 1}, sid=s)
time.sleep(4)
shot("/tmp/gis_province.png", s)

# farm: click first farm of hebei (张家口坝上 40.95,114.88)
pt = ev("(() => { const m = window.__map; const p = m.project([114.88, 40.95]); return JSON.stringify({x: p.x, y: p.y}); })()", s)
print("farm px:", pt)
pos = json.loads(pt)
send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": int(pos["x"]), "y": int(pos["y"]), "button": "left", "clickCount": 1}, sid=s)
send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": int(pos["x"]), "y": int(pos["y"]), "button": "left", "clickCount": 1}, sid=s)
time.sleep(5)
shot("/tmp/gis_farm.png", s)

print("crumbs:", ev("document.querySelector('.level-crumbs')?.innerText", s))
print("farm card:", ev("document.querySelector('.farm-detail-card')?.innerText?.slice(0,160)", s))

send("Target.closeTarget", {"targetId": t})
ws.close()
