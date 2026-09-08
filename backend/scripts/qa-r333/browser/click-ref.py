import asyncio,json,sys,urllib.request,subprocess,base64,os
from pathlib import Path
import websockets
os.environ['DISPLAY']=':0'
async def main():
 tab=next(t for t in json.load(urllib.request.urlopen('http://localhost:29229/json')) if t['type']=='page' and 'suinian.zalize.com' in t['url'])
 async with websockets.connect(tab['webSocketDebuggerUrl'],ping_interval=None) as ws:
  async def cmd(m,p):
   await ws.send(json.dumps({'id':1,'method':m,'params':p}))
   while True:
    r=json.loads(await ws.recv())
    if r.get('id')==1:return r['result']
  async def ev(s):return (await cmd('Runtime.evaluate',{'expression':s,'returnByValue':True}))['result'].get('value')
  pos=await ev("""(()=>{let b=[...document.querySelectorAll('.flex.justify-start')].at(-1).querySelector('button[aria-label^="跳转到引用笔记"]');let r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2+outerHeight-innerHeight}})()""")
  subprocess.run(['xdotool','mousemove',str(round(pos['x'])),str(round(pos['y'])),'click','1'],check=True)
  await asyncio.sleep(.3)
  r=await cmd('Page.captureScreenshot',{'format':'png'})
  (Path(__file__).parent/(sys.argv[1]+'-clicked.png')).write_bytes(base64.b64decode(r['data']))
  print(await ev("""(()=>{let e=document.querySelector('[id^="ask-ref-"].ring-2');return {ring:!!e,id:e?.id}})()"""))
asyncio.run(main())
