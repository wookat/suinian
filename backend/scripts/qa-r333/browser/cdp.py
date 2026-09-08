import asyncio,json,sys,urllib.request,base64
import websockets
async def main():
    tabs=json.load(urllib.request.urlopen('http://localhost:29229/json'))
    tab=next(t for t in tabs if t['type']=='page' and 'suinian.zalize.com' in t['url'])
    async with websockets.connect(tab['webSocketDebuggerUrl'],max_size=20000000,ping_interval=None) as ws:
        async def cmd(method,params):
            await ws.send(json.dumps({'id':1,'method':method,'params':params}))
            while True:
                r=json.loads(await ws.recv())
                if r.get('id')==1:return r.get('result',{})
        if sys.argv[1]=='login':
            a=json.load(open('/home/ubuntu/repos/suinian/backend/scripts/qa-r333/out/account-pair.json'))['A']
            assert a['name'].startswith('[QA-R333]oracleA')
            s={'apiBaseUrl':'https://suinian-api.zalize.com','apiToken':a['token'],'useMock':False,'onboarded':True,'tourSeen':True}
            await cmd('Runtime.evaluate',{'expression':"localStorage.setItem('suinian.settings',"+json.dumps(json.dumps(s))+");location.reload();void 0"})
            print(a['name'])
        elif sys.argv[1]=='shot':
            r=await cmd('Page.captureScreenshot',{'format':'png'})
            open(sys.argv[2],'wb').write(base64.b64decode(r['data']))
        else:
            r=await cmd('Runtime.evaluate',{'expression':sys.argv[2],'returnByValue':True,'awaitPromise':True})
            print(json.dumps(r.get('result',{}).get('value'),ensure_ascii=False))
asyncio.run(main())
