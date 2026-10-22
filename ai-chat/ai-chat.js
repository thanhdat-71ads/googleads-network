/* =====================================================================================
   AI CHAT — LÕI TRỢ LÝ DỮ LIỆU DÙNG CHUNG CHO CÁC DASHBOARD (71 ADS)  · v2.1
   -------------------------------------------------------------------------------------
   File này KHÔNG chứa dữ liệu hay công thức riêng của dashboard nào. Nó lo:
     • Nút mở chat dạng "Hỏi AI số liệu" (lần đầu hiện chữ rồi thu gọn) + khung chat
     • Khung nổi mặc định, bấm ⤢ để phóng thành ngăn kéo cao toàn màn hình (nhớ lựa chọn)
     • Thẻ chào + câu hỏi nhanh, xưng hô Anh/Chị, gợi ý câu hỏi phía trên ô nhập
     • Hiện từng bước AI đang tra cứu, thẻ số liệu trong câu trả lời, nút Sao chép
     • Gọi Apps Script (action:'chat') kèm Firebase ID token → Apps Script gọi Gemini
       (API key Gemini nằm trong Script Properties của Apps Script, KHÔNG nằm ở đây)
     • Vòng lặp AI Agent: Gemini yêu cầu công cụ → chạy công cụ của dashboard → gửi kết quả lại
     • Gemini lỗi / hết quota → tự chuyển sang trợ lý quy tắc của dashboard (nếu có)
     • Đăng xuất Firebase → xoá sạch hội thoại

   Mỗi dashboard có 1 file công cụ riêng (vd hub-tools.js) gọi AIChat.init({...}):
     title, subtitle, placeholder, launcherText      — chữ hiển thị
     welcomeTitle, welcomeText                       — thẻ chào
     quickActions: [{icon, title, desc, q}]          — 4 thẻ câu hỏi nhanh trong thẻ chào
     suggestions: [câu hỏi]                          — gợi ý phía trên ô nhập
     toolLabels: {ten_cong_cu: "Nhãn hiển thị"}      — tên bước khi AI tra cứu
     panelBottom                                     — khoảng cách khung chat tới đáy (px)
     tools, runTool(name,args), systemPrompt({address}), isReady(), getUrl()
     ruleHandle(text) → trợ lý quy tắc dự phòng (tuỳ chọn) · onOpen() / onClose() (tuỳ chọn)
   ===================================================================================== */
(function(){
  "use strict";
  const AUTH_ERRORS = ["AUTH_REQUIRED","INVALID_TOKEN","NOT_ALLOWED","EMAIL_NOT_VERIFIED","USER_DISABLED","NOT_CONFIGURED","VERIFY_FAILED"];
  const MAX_ROUNDS = 6, HISTORY_MSGS = 12, CHAT_TIMEOUT_MS = 120000;
  const BIG_KEY = "aichat_big", PEEK_KEY = "aichat_peeked";

  // ---------- robot (SVG vẽ mới) ----------
  const robot = (size, cls) => `<svg class="aicRobot ${cls||""}" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">
    <circle class="aicAnt" cx="24" cy="6.5" r="2.4" fill="#7ff3ff"/><path d="M24 9v4" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="9" y="13" width="30" height="23" rx="9.5" fill="#fff"/><rect x="5.5" y="20.5" width="3.5" height="8" rx="1.75" fill="#fff"/><rect x="39" y="20.5" width="3.5" height="8" rx="1.75" fill="#fff"/>
    <rect x="13" y="17.5" width="22" height="13.5" rx="6.5" fill="#17225a"/>
    <ellipse class="aicEye" cx="19.8" cy="24.2" rx="2.2" ry="2.8" fill="#7ff3ff"/><ellipse class="aicEye" cx="28.2" cy="24.2" rx="2.2" ry="2.8" fill="#7ff3ff"/>
  </svg>`;
  const IC = {
    edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    big:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    small:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
    close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    send:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>'
  };

  let cfg = null, els = {}, address = "", history = [], busy = false, opened = false, aiOffUntil = 0;

  // ---------- tiện ích ----------
  const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const norm = s => String(s==null?"":s).normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/đ/gi,"d").toLowerCase().trim();
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const store = {
    get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
    set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} },
    sget(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } },
    sset(k,v){ try{ sessionStorage.setItem(k,v); }catch(e){} }
  };

  // Markdown đơn giản → HTML an toàn. Dòng [[KPI: Nhãn=Giá trị | ...]] → thẻ số liệu.
  function mdToHtml(md){
    const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g,"<b>$1</b>").replace(/(^|[^*])\*([^*\n]+)\*/g,"$1<i>$2</i>").replace(/`([^`]+)`/g,"<code>$1</code>");
    const out = []; let list = null;
    const close = () => { if(list){ out.push(`</${list}>`); list = null; } };
    String(md||"").replace(/\r/g,"").split("\n").forEach(line => {
      const t = line.trim(); let m;
      if(!t){ close(); return; }
      if((m = t.match(/^\[\[\s*KPI\s*:(.+)\]\]$/i))){
        close();
        const cells = m[1].split("|").map(x => x.split("=")).filter(x => x.length >= 2).slice(0,4);
        if(cells.length) out.push(`<div class="aicKpis">${cells.map(([k,...v]) => { const val = v.join("=").trim(); const cls = /▲|↑|tăng/i.test(val) ? " up" : /▼|↓|giảm/i.test(val) ? " down" : ""; return `<div><small>${esc(k.trim())}</small><strong class="${cls}">${esc(val)}</strong></div>`; }).join("")}</div>`);
        return;
      }
      if((m = t.match(/^#{1,6}\s+(.*)$/))){ close(); out.push(`<h5>${inline(m[1])}</h5>`); return; }
      if((m = t.match(/^[-*•]\s+(.*)$/))){ if(list!=="ul"){ close(); out.push("<ul>"); list="ul"; } out.push(`<li>${inline(m[1])}</li>`); return; }
      if((m = t.match(/^(\d+)[.)]\s+(.*)$/))){ if(list!=="ol"){ close(); out.push(`<ol start="${m[1]}">`); list="ol"; } out.push(`<li>${inline(m[2])}</li>`); return; }
      if(/^\|.*\|$/.test(t)){ if(/^\|[\s:|-]+\|$/.test(t)) return; close(); out.push(`<p>${inline(t.replace(/^\||\|$/g,"").split("|").map(s=>s.trim()).join(" · "))}</p>`); return; }
      close(); out.push(`<p>${inline(t)}</p>`);
    });
    close();
    return out.join("");
  }

  // ---------- giao diện ----------
  function $id(id){ return document.getElementById(id); }
  function mount(){
    if($id("botFab")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML =
      `<button id="botFab" class="botFab aicFab" type="button" title="${esc(cfg.title)}" aria-label="Mở ${esc(cfg.title)}">
         <span class="aicFace">${robot(34)}</span><span class="aicFabTxt">${esc(cfg.launcherText)}</span><span class="aicLive" aria-hidden="true"></span><span class="aicBadge" aria-hidden="true">1</span>
       </button>
       <div class="botPanel aicPanel" id="botPanel" hidden role="dialog" aria-label="${esc(cfg.title)}">
         <div class="aicHead">
           <div class="aicAva">${robot(30)}<span class="aicOn"></span></div>
           <div class="aicHeadTxt"><b>${esc(cfg.title)} <span class="aicTag">AI</span></b><span>● ${esc(cfg.subtitle)}</span></div>
           <button class="aicHBtn" id="aicNew" type="button" title="Cuộc trò chuyện mới">${IC.edit}</button>
           <button class="aicHBtn" id="aicBig" type="button" title="Phóng to">${IC.big}</button>
           <button class="aicHBtn" id="botCloseBtn" type="button" title="Đóng" aria-label="Đóng">${IC.close}</button>
         </div>
         <div class="botMsgs aicMsgs" id="botMsgs"></div>
         <div class="aicSugg" id="aicSugg"></div>
         <div class="aicInput"><div class="aicBox">
           <input type="text" id="botInput" placeholder="${esc(cfg.placeholder)}" autocomplete="off">
           <button id="botSendBtn" class="aicSend" type="button" aria-label="Gửi">${IC.send}</button>
         </div></div>
         <div class="aicLegal">AI có thể sai sót — kiểm tra lại số liệu quan trọng trước khi ra quyết định</div>
       </div>`;
    while(wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);
    els = { fab:$id("botFab"), panel:$id("botPanel"), msgs:$id("botMsgs"), input:$id("botInput"), send:$id("botSendBtn"),
            close:$id("botCloseBtn"), big:$id("aicBig"), neu:$id("aicNew"), sugg:$id("aicSugg") };
    if(cfg.panelBottom) document.documentElement.style.setProperty("--aic-panel-bottom", cfg.panelBottom + "px");
    els.fab.addEventListener("click", open);
    els.close.addEventListener("click", close);
    els.big.addEventListener("click", () => setBig(!els.panel.classList.contains("aicBig"), true));
    els.neu.addEventListener("click", newChat);
    els.send.addEventListener("click", () => send(els.input.value));
    els.input.addEventListener("keydown", e => { if(e.key === "Enter") send(els.input.value); });
    document.addEventListener("keydown", e => { if(e.key === "Escape" && !els.panel.hidden) close(); });
    setBig(store.get(BIG_KEY) === "1", false);
    renderSugg();
    // Lần đầu trong phiên: hiện chữ "Hỏi AI số liệu" 4 giây rồi thu gọn
    if(!store.sget(PEEK_KEY)){ els.fab.classList.add("aicPeek"); setTimeout(() => els.fab.classList.remove("aicPeek"), 4500); store.sset(PEEK_KEY,"1"); }
  }
  function setBig(on, save){
    els.panel.classList.toggle("aicBig", on);
    els.big.innerHTML = on ? IC.small : IC.big;
    els.big.title = on ? "Thu nhỏ" : "Phóng to";
    if(save) store.set(BIG_KEY, on ? "1" : "0");
    scrollBottom();
  }
  function renderSugg(){
    els.sugg.innerHTML = (cfg.suggestions || []).map((q,i) => `<button type="button" data-i="${i}">${esc(q)}</button>`).join("");
    els.sugg.querySelectorAll("button").forEach(b => b.addEventListener("click", () => send(cfg.suggestions[+b.dataset.i])));
    els.sugg.hidden = !(cfg.suggestions || []).length;
  }
  function renderWelcome(){
    const card = document.createElement("div");
    card.className = "aicWelcome";
    const hello = address ? `Chào ${address} 👋 Hôm nay cần xem gì?` : (cfg.welcomeTitle || "Xin chào 👋");
    card.innerHTML = `<h4>${esc(hello)}</h4><p>${cfg.welcomeText}</p>` +
      (address ? "" : `<div class="aicAddr"><span>Mình nên gọi bạn là</span><button type="button" data-a="Anh">Anh</button><button type="button" data-a="Chị">Chị</button></div>`) +
      ((cfg.quickActions||[]).length ? `<div class="aicQuick">${cfg.quickActions.map((a,i) => `<button type="button" class="aicQc" data-i="${i}"><i style="background:${esc(a.bg||"var(--aic-soft)")}">${esc(a.icon||"✦")}</i><span><b>${esc(a.title)}</b><small>${esc(a.desc||"")}</small></span></button>`).join("")}</div>` : "");
    els.msgs.appendChild(card);
    card.querySelectorAll(".aicAddr button").forEach(b => b.addEventListener("click", () => {
      address = b.dataset.a === "Chị" ? "chị" : "anh";
      card.querySelector("h4").textContent = `Chào ${address} 👋 Hôm nay cần xem gì?`;
      const row = card.querySelector(".aicAddr"); if(row) row.remove();
    }));
    card.querySelectorAll(".aicQc").forEach(b => b.addEventListener("click", () => send(cfg.quickActions[+b.dataset.i].q)));
    scrollBottom();
  }

  function open(){
    els.panel.hidden = false; els.fab.classList.add("open");
    document.documentElement.classList.add("aic-open");
    els.fab.classList.remove("aicUnread");
    if(cfg.onOpen) try{ cfg.onOpen(); }catch(e){}
    if(!opened){ opened = true; renderWelcome(); }
    setTimeout(() => els.input.focus(), 100);
  }
  function close(){
    els.panel.hidden = true; els.fab.classList.remove("open");
    document.documentElement.classList.remove("aic-open");
    if(cfg.onClose) try{ cfg.onClose(); }catch(e){}
  }
  function scrollBottom(){ if(els.msgs) els.msgs.scrollTop = els.msgs.scrollHeight; }
  function newChat(){
    history = []; els.msgs.innerHTML = ""; renderWelcome(); els.input.focus();
  }
  function reset(){
    history = []; opened = false; address = ""; busy = false;
    if(els.msgs) els.msgs.innerHTML = "";
    if(els.panel) close();
  }

  // Bong bóng tin nhắn. Trả về phần thân bong bóng (trợ lý quy tắc dùng để gắn thêm nút).
  function addBubble(html, sender){
    if(!els.msgs) return null;
    const me = sender === "user";
    const row = document.createElement("div");
    row.className = "aicRow " + (me ? "me" : "ai");
    if(!me) row.innerHTML = `<div class="aicMini">${robot(18)}</div>`;
    const b = document.createElement("div");
    b.className = "botBubble " + (me ? "user" : "bot");
    b.innerHTML = html;
    row.appendChild(b);
    els.msgs.appendChild(row); scrollBottom();
    return b;
  }
  function addChips(items){
    if(!els.msgs) return;
    const row = document.createElement("div");
    row.className = "botChipRow";
    row.innerHTML = items.map((it,i) => `<button class="botChip" type="button" data-i="${i}">${esc(it.label)}</button>`).join("");
    els.msgs.appendChild(row);
    row.querySelectorAll(".botChip").forEach((el,i) => el.addEventListener("click", () => { row.remove(); items[i].action(); }));
    scrollBottom();
  }
  function showSuggestions(){
    if(cfg.suggestions && cfg.suggestions.length) addChips(cfg.suggestions.map(q => ({label:q, action:()=>send(q)})));
  }
  // Khối "đang làm": danh sách bước ✓ + bước đang chạy
  function progress(firstStep){
    const box = document.createElement("div");
    box.className = "aicSteps";
    els.msgs.appendChild(box);
    const done = [];
    let current = firstStep || "Đang suy nghĩ…";
    const draw = () => { box.innerHTML = done.map(s => `<span class="ok">${esc(s)}</span>`).join("") + (current ? `<span class="run">${esc(current)}</span>` : ""); scrollBottom(); };
    draw();
    const finish = () => { const c = (current || "").replace(/…$/,""); if(c && current !== firstStep && !/^Đang viết/.test(c) && !done.includes(c)) done.push(c); };
    return {
      step(label){ finish(); current = label; draw(); },
      writing(){ finish(); current = "Đang viết phân tích…"; draw(); },
      remove(){ box.remove(); }
    };
  }
  function addCopy(bubble){
    const foot = document.createElement("div");
    foot.className = "aicFoot";
    foot.innerHTML = `<span>✦ AI phân tích từ dữ liệu dashboard</span><button type="button">Sao chép</button>`;
    const btn = foot.querySelector("button");
    btn.addEventListener("click", async () => {
      const text = bubble.innerText.replace(foot.innerText, "").replace(/\n{3,}/g, "\n\n").trim();
      try{ await navigator.clipboard.writeText(text); }
      catch(e){ const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try{ document.execCommand("copy"); }catch(x){} ta.remove(); }
      btn.textContent = "Đã chép ✓"; setTimeout(() => btn.textContent = "Sao chép", 1600);
    });
    bubble.appendChild(foot);
  }

  // ---------- gửi câu hỏi ----------
  function send(text){
    text = String(text || "").trim(); if(!text) return;
    if(els.panel.hidden) open();
    addBubble(esc(text), "user");
    els.input.value = "";
    handle(text);
  }

  async function handle(raw){
    const nq = norm(raw);
    if(/^(anh|chi)$/.test(nq)){
      address = nq === "chi" ? "chị" : "anh";
      addBubble(`Dạ vâng ${address}! Giờ ${address} có thể hỏi mình bất cứ điều gì về dữ liệu của dashboard nhé.`, "bot");
      return;
    }
    if(/^(cam on|thanks|thank you|ok|oke)$/.test(nq)){ addBubble(`Dạ không có gì ${address||"bạn"}! Cần hỏi gì thêm cứ nhắn mình nhé.`, "bot"); return; }
    if(busy){ addBubble("Mình đang xử lý câu trước, đợi chút nhé…", "bot"); return; }

    const aiOk = cfg.tools && cfg.tools.length && Date.now() >= aiOffUntil && window.kwFirebase && cfg.getUrl && cfg.getUrl();
    if(!aiOk) return fallback(raw);
    if(cfg.isReady && !cfg.isReady()){ addBubble("Dashboard chưa tải xong dữ liệu — bấm <b>Cập nhật</b> rồi hỏi lại mình nhé.", "bot"); return; }

    busy = true; els.send.disabled = true; els.input.placeholder = "AI đang phân tích, chờ chút nhé…";
    const p = progress("Đang hiểu câu hỏi…");
    try{
      const text = await runAgent(raw, p);
      p.remove();
      const b = addBubble(mdToHtml(text), "bot");
      if(b){ b.classList.add("botAi"); addCopy(b); scrollBottom(); }
    }catch(e){
      p.remove();
      const code = e && e.code;
      if(AUTH_ERRORS.includes(code)){
        addBubble("Phiên đăng nhập đã hết hạn — vui lòng đăng nhập lại nhé.", "bot");
      } else {
        if(["AI_NOT_CONFIGURED","AI_CONFIG","BAD_REQUEST"].includes(code)) aiOffUntil = Date.now() + 10*60*1000;
        else if(["AI_RATE_LIMIT","AI_DAILY_LIMIT"].includes(code)) aiOffUntil = Date.now() + 60*1000;
        console.warn("[AI Chat]", code, e && e.message);
        addBubble(`<span class="botHint" style="margin-top:0">AI tạm thời chưa dùng được (${esc((e && e.message) || "lỗi kết nối")})${cfg.ruleHandle ? " — mình trả lời bằng chế độ cơ bản:" : "."}</span>`, "bot");
        fallback(raw);
      }
    }finally{
      busy = false; els.send.disabled = false; els.input.placeholder = cfg.placeholder; scrollBottom();
      if(els.panel.hidden) els.fab.classList.add("aicUnread");     // trả lời xong lúc khung chat đang đóng → báo chấm đỏ
    }
  }
  function fallback(raw){
    if(cfg.ruleHandle) return cfg.ruleHandle(raw);
    addBubble("Trợ lý AI chưa sẵn sàng (chưa đăng nhập hoặc chưa kết nối máy chủ dữ liệu).", "bot");
  }

  // ---------- gọi Apps Script → Gemini ----------
  async function postOnce(url, body){
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
    let json;
    try{
      const res = await fetch(url, {method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"}, body:JSON.stringify(body), signal:ctrl.signal});
      if(!res.ok) throw Object.assign(new Error("HTTP " + res.status), {code:"NET_" + res.status, transient: res.status === 404 || res.status >= 500});
      try{ json = JSON.parse(await res.text()); }catch(e){ throw Object.assign(new Error("Máy chủ trả về phản hồi không hợp lệ"), {transient:true}); }
    }catch(e){
      if(e && e.name === "AbortError") throw Object.assign(new Error("Quá thời gian chờ AI trả lời"), {code:"AI_TIMEOUT"});
      if(e && e.name === "TypeError") e.transient = true;          // mất kết nối tạm thời
      throw e;
    }finally{ clearTimeout(timer); }
    if(json && json.success === false){
      const err = new Error(json.message || json.error || "Máy chủ báo lỗi"); err.code = json.error; err.detail = json.detail || "";
      if(err.code === "AUTH_REQUIRED" && err.detail === "GET") err.transient = true;   // Google chuyển hướng yêu cầu thành GET
      throw err;
    }
    return json;
  }
  // Google Apps Script thỉnh thoảng trả 404 ở bước chuyển hướng hoặc biến POST thành GET → tự thử lại tối đa 3 lần
  async function post(url, body){
    for(let attempt = 1; ; attempt++){
      try{ return await postOnce(url, body); }
      catch(e){
        if(e && e.transient && attempt < 3){
          console.warn(`[AI Chat] lỗi đường truyền (${e.code || e.message}), thử lại lần ${attempt + 1}…`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        throw e;
      }
    }
  }
  async function callGemini(contents){
    const fb = window.kwFirebase;
    const body = {action:"chat", idToken: await fb.getToken(false), system: cfg.systemPrompt({address}), tools: cfg.tools, contents};
    try{ return await post(cfg.getUrl(), body); }
    catch(e){
      if(e && e.code === "INVALID_TOKEN"){ body.idToken = await fb.getToken(true); return await post(cfg.getUrl(), body); }
      throw e;
    }
  }
  async function runAgent(question, p){
    const turn = [{role:"user", parts:[{text:question}]}];
    for(let round = 0; round < MAX_ROUNDS; round++){
      const t0 = Date.now();
      const res = await callGemini(history.concat(turn));
      console.info(`[AI Chat] vòng ${round+1}: model ${res.model||"?"} · Gemini ${res.ms!=null?res.ms+"ms":"?"} · tổng ${Date.now()-t0}ms` + (res.tries ? ` · lượt gọi: ${res.tries}` : ""));
      const content = res.content || {role:"model", parts:[]};
      if(!content.role) content.role = "model";
      const parts = content.parts || [];
      const calls = parts.filter(x => x.functionCall);
      turn.push(content);                                  // giữ nguyên (kể cả thoughtSignature) để Gemini nối mạch
      if(!calls.length){
        const text = parts.filter(x => x.text && !x.thought).map(x => x.text).join("").trim();
        history = history.concat([turn[0], {role:"model", parts:[{text: text || "(không có nội dung)"}]}]).slice(-HISTORY_MSGS);
        return text;
      }
      const respParts = calls.map(x => {
        const fc = x.functionCall;
        const label = (cfg.toolLabels && cfg.toolLabels[fc.name]) || ("Tra cứu " + String(fc.name).replace(/_/g," "));
        p.step(label + "…");
        let out;
        try{ out = cfg.runTool(fc.name, fc.args || {}); }
        catch(e){ out = {loi: "Lỗi khi tính: " + e.message}; }
        return {functionResponse:{name:fc.name, response:{ket_qua: out === undefined ? {loi:"Không có công cụ " + fc.name} : out}}};
      });
      p.writing();
      turn.push({role:"user", parts:respParts});
    }
    throw Object.assign(new Error("Quá nhiều bước tra cứu"), {code:"AI_LOOP"});
  }

  // Đăng xuất Firebase → xoá hội thoại
  function hookAuth(){
    if(window.kwFirebase && window.kwFirebase.onChange) window.kwFirebase.onChange(u => { if(!u) reset(); });
    else window.addEventListener("kwfirebase-ready", hookAuth, {once:true});
  }

  // ---------- API công khai ----------
  function init(options){
    cfg = Object.assign({
      title: "Trợ lý dữ liệu",
      subtitle: "Đang hoạt động · Gemini",
      placeholder: "Hỏi về số liệu của dashboard…",
      launcherText: "Hỏi AI số liệu",
      welcomeTitle: "Xin chào 👋",
      welcomeText: "Mình đọc trực tiếp số liệu đang hiển thị trên dashboard (theo bộ lọc hiện tại) và phân tích như chuyên gia.",
      quickActions: [], suggestions: [], toolLabels: {},
      tools: [], runTool: () => undefined, systemPrompt: () => "", panelBottom: 0
    }, options || {});
    const go = () => { mount(); hookAuth(); };
    if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  }
  window.AIChat = { init, send, addBubble, addChips, showSuggestions, scrollBottom, open, close, reset, newChat, mdToHtml, esc, norm, cap,
    address: () => address, version: "2.1" };
})();
