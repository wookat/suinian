#!/usr/bin/env bash
# R3 regression smoke against production. Usage: SUINIAN_TOKEN=... bash scripts/qa-r3-smoke.sh
set -u
API=https://suinian-api.zalize.com
H="Authorization: Bearer $SUINIAN_TOKEN"
J="content-type: application/json"

echo "== health =="
curl -s $API/health

echo; echo "== 1. POST /api/notes (async triage) =="
N1=$(curl -s -X POST $API/api/notes -H "$H" -H "$J" -d '{"source":"api","content":"[QA-B] R3冒烟：想法笔记，关于碎念的敏感内容加密上线"}')
echo "$N1" | python3 -c "import json,sys; n=json.load(sys.stdin)['note']; print('id:',n['id'],'category:',n['category'])"
ID1=$(echo "$N1" | python3 -c "import json,sys; print(json.load(sys.stdin)['note']['id'])")

echo; echo "== 2. sensitive note (encrypt at rest, transparent decrypt) =="
N2=$(curl -s -X POST $API/api/ingest/wechat -H "$H" -H "$J" -d '{"content":"[QA-B] 测试服务器密码是 QaB-Sm0ke-P@ss-2026"}')
echo "$N2" | python3 -c "import json,sys; d=json.load(sys.stdin); n=d['note']; print('reply:',d['reply']); print('is_sensitive:',n['is_sensitive']); print('content contains plaintext:', 'QaB-Sm0ke-P@ss-2026' in n['content']); print('content_enc leaked:', n.get('content_enc') is not None)"
ID2=$(echo "$N2" | python3 -c "import json,sys; print(json.load(sys.stdin)['note']['id'])")

echo; echo "-- raw D1 row for sensitive note (must be placeholder + ciphertext) --"
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/$D1_DATABASE_ID/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "$J" \
  -d "{\"sql\":\"SELECT content, substr(content_enc,1,20) AS enc_prefix FROM notes WHERE id = ?\",\"params\":[\"$ID2\"]}" |
  python3 -c "import json,sys; r=json.load(sys.stdin)['result'][0]['results'][0]; print('D1 content:',r['content'],'| content_enc prefix:',r['enc_prefix'])"

echo; echo "-- GET /api/notes returns decrypted plaintext --"
curl -s "$API/api/notes?limit=5" -H "$H" | python3 -c "
import json,sys
for n in json.load(sys.stdin)['notes']:
    if n['id']=='$ID2':
        print('decrypted ok:', 'QaB-Sm0ke-P@ss-2026' in n['content'])"

echo; echo "== 3. multi-URL note (first 3 titles) =="
N3=$(curl -s -X POST $API/api/notes -H "$H" -H "$J" -d '{"content":"[QA-B] 三个链接 https://example.com/ 和 https://www.rust-lang.org/ 和 https://developer.mozilla.org/zh-CN/"}')
ID3=$(echo "$N3" | python3 -c "import json,sys; print(json.load(sys.stdin)['note']['id'])")
sleep 12
curl -s "$API/api/notes?limit=10" -H "$H" | python3 -c "
import json,sys
for n in json.load(sys.stdin)['notes']:
    if n['id']=='$ID3':
        print('url:',n['url']); print('url_title:',n['url_title']); print('url_titles:',json.dumps(n['url_titles'],ensure_ascii=False))"

echo; echo "== 4. 20k limit -> 413 =="
python3 -c "print('{\"content\":\"'+'字'*20001+'\"}')" > /tmp/long.json
curl -s -o /tmp/413.json -w "status:%{http_code}\n" -X POST $API/api/notes -H "$H" -H "$J" --data @/tmp/long.json
cat /tmp/413.json; echo

echo; echo "== 5. ask (Chinese long sentence) =="
curl -s -X POST $API/api/ask -H "$H" -H "$J" -d '{"question":"我最近这段时间在琢磨和记录的关于碎念这个产品的想法主要都集中在哪些方面，能帮我总结一下吗？"}' |
  python3 -c "import json,sys; d=json.load(sys.stdin); print('answer:',d['answer'][:120].replace(chr(10),' ')); print('references:',len(d['references']))"

echo; echo "== 6. threads =="
curl -s $API/api/threads -H "$H" | python3 -c "import json,sys; print('threads:',len(json.load(sys.stdin)['threads']))"
echo "-- thread 404 --"
curl -s -o /tmp/t404.json -w "status:%{http_code} content-type:%{content_type}\n" $API/api/threads/does-not-exist -H "$H"; cat /tmp/t404.json; echo

echo; echo "== 7. reports =="
curl -s $API/api/reports -H "$H" | python3 -c "import json,sys; print('reports:',len(json.load(sys.stdin)['reports']))"
echo "-- report 404 --"
curl -s -o /tmp/r404.json -w "status:%{http_code} content-type:%{content_type}\n" $API/api/reports/does-not-exist -H "$H"; cat /tmp/r404.json; echo
echo "-- unknown route 404 --"
curl -s -o /tmp/u404.json -w "status:%{http_code} content-type:%{content_type}\n" $API/api/nope -H "$H"; cat /tmp/u404.json; echo

echo; echo "== 8. export =="
curl -s "$API/api/export" -H "$H" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('notes:',len(d['notes']),'threads:',len(d['threads']),'reports:',len(d['reports']))
leaks=[n['id'] for n in d['notes'] if n.get('content_enc')]
print('content_enc leaked in export:', bool(leaks))
enc_still_masked=[n['id'] for n in d['notes'] if n['is_sensitive'] and n['content']=='[加密内容]']
print('sensitive notes still masked in export (should be 0):', len(enc_still_masked))"

echo; echo "== cleanup [QA-B] notes =="
for id in $ID1 $ID2 $ID3; do
  curl -s -X DELETE $API/api/notes/$id -H "$H"; echo
done
