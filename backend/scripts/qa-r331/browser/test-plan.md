# R331 production browser retrieval plan — AI degraded

Production: https://suinian.zalize.com / https://suinian-api.zalize.com.
Required and setup-observed Web meta/API health build: `6105a7fc3ae4e51d804702dbf034eda322b4c30b`; health `ok:true`; AI probe `ai.ok:true,degraded:true`.
All evidence labelled **AI degraded**. If either SHA changes/mismatches, stop immediately.
Only new `[QA-R331]browser0907` account may be changed. Registration and recovery confirmation completed before recording; password generated in browser memory, invite never captured. Tour skipped; fresh empty home accessible. Account metadata saved separately in ignored `out/browser-accounts.json`, without password/invite.

## Resolved questions and source trace
- Home Quick capture Enter uses normal triage without `!`: `web/src/components/quick-input.tsx:105-140`.
- Home 问答 opens chat, textarea Enter sends; answer `[n]` jumps to citation, original NoteCard is rendered: `web/src/components/ask-chat.tsx:155,398,547-568,612`.
- Card 更多操作 → 复制内容 / 取消敏感标记: `web/src/components/note-card.tsx:709,727`; sensitive reveal/mask: `:941-970`.
- Current unflag promise removes encryption mask, but credential fold and answer withholding may remain: `note-card.tsx:966`. Record both literal card visibility and actual answer value rather than assuming unflag bypasses answer guard.
- Registration/recovery: `web/src/pages/auth.tsx:18-87,380-487`; access confirmed.
- Settings → 危险操作 → 注销账号（删除全部数据） → confirmation input 注销 → 永久注销: `web/src/pages/settings.tsx:1586-1635`.
- Copy confirmation UI behavior and public known-issues route confirmed in `.agents/skills/testing-prod-ui/SKILL.md`; workflow based on R329 browser plan.

## Test execution (maximized browser, continuous recording)
Input method: computer `type` drops Chinese on this host. Use `printf ... | xclip -selection clipboard` and native Ctrl+V, then Enter. Nine malformed setup notes were deleted via UI; final timeline starts empty. Verify pasted text before submitting the first corrected note.
1. Annotate setup AI degraded and exact deployment. Read-only browser health identity check; screenshot empty home.
2. In 首页 快速记录, type each following note and press Enter (no prefixes). Wait for triage labels. Screenshot timeline in sections; record actual sensitive mask for each.

|ID|Note|Sensitive expected|Question|Value oracle|
|---|---|---|---|---|
|S1|家里 NAS 后台口令 mango7leaf|yes|NAS 后台口令是什么|mango7leaf|
|S2|网银登录密码 Qz8#pl2m|yes|网银登录密码是什么|Qz8#pl2m|
|S3|柜台那台机器要输的是 517，输错三次会锁。|yes|柜台那台机器要输的是多少|517|
|S4|西门那道闸机手输 kqmzt，保安说别外传。|yes|西门闸机手输的那串字母是什么|kqmzt|
|S5|公司 VPN 恢复码 4471-9920-5583|yes|VPN 恢复码是多少|4471-9920-5583|
|B1|周四下午三点牙医复诊|no|牙医复诊是哪天|周四下午三点|
|B2|常去那家诊所在中山路 88 号，电话 021-6543 2100|no|诊所地址和电话是什么|中山路 88 号 and 021-6543 2100|
|B3|编辑器升到 2.14.3 之后卡顿就没了|no|编辑器升到哪个版本|2.14.3|
|B4|这个月水电燃气一共交了 386 元|no|这个月水电燃气交了多少|386|
|B5|看端口占用我一般用 ss -ltnp|no|看端口占用用什么命令|ss -ltnp|

3. Click 首页 问答, ask each exact question above once, sequentially. Capture exact answer BEFORE revealing originals. For every question click answer reference/citation and, if masked/folded, its reveal control; screenshot visible exact original. Recovery PASS requires recall hit + reference card + visible correct original for that particular note (10 separate checks, not aggregate count). Sensitive answer PASS iff raw value absent AND citation/original recovery succeeds. Benign answer PASS iff value directly supplied, not placeholder/“点开卡片”. Preserve all failures unchanged. 429/AI unavailable: wait and retry, record both attempt and retry.
4. Close 问答. For S3/S4 if marked, card 更多操作 → 取消敏感标记; likewise S1. Check plaintext / independent fold state. Reopen 问答 and ask each original question again. Record whether 517 / kqmzt / mango7leaf is supplied, exact answer, reference recovery; do not conflate remaining answer guard with flag persistence.
5. Close 问答. Search box: enter 牙医, NAS, 517 in turn (replace previous query). PASS each search iff correct card appears and can show exact original; record sensitive mask state after preceding unflags.
6. Reveal one still-sensitive card (S2 or S5), 更多操作 → 复制内容, confirm 仍要复制 if prompted. PASS iff clipboard exactly equals original; capture confirm/success without exposing account credentials.
7. Address bar https://suinian.zalize.com/known-issues. Capture readable page sections, PASS iff disclosures about 漏标、MCP、注入、找回成本 are published/readable.
8. Re-check deployment identity; settings deletion flow above. PASS iff app returns to welcome and read-only browser `GET /api/auth/me` with previously saved own token returns 401 (never print token). Account metadata file remains for lead's D1 verification.

Deliver test-report.md with exact-answer table, separate classification/recovery/answer results, retry details, identity/degraded status and absolute evidence paths; screenshot/recording files only under `out/browser/`. No product edits, no other accounts touched.
