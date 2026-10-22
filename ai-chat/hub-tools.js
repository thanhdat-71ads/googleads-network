/* =====================================================================================
   HUB-TOOLS — PHẦN RIÊNG CỦA GOOGLE ADS PERFORMANCE HUB CHO TRỢ LÝ AI (71 ADS)
   -------------------------------------------------------------------------------------
   Nạp SAU ai-chat.js và SAU script chính của dashboard (dùng các hàm/biến của Hub:
   actualSummary, kpiSummary, actualRowsByRegion, collectAlerts, campaignRows, F, ...).
   Gồm 4 phần:
     1. Công cụ AI (TOOLS + RUN) — Gemini gọi để lấy số liệu, cùng công thức với dashboard
     2. Lời dặn AI (systemPrompt) — vai trò, định nghĩa chỉ số, bối cảnh dữ liệu hiện tại
     3. Trợ lý quy tắc cũ — dự phòng khi Gemini lỗi / hết quota
     4. Gắn tất cả vào lõi AIChat (tiêu đề, câu chào, gợi ý câu hỏi, vị trí khung chat)
   Thêm công cụ mới: khai báo trong TOOLS + viết hàm cùng tên trong RUN.
   ===================================================================================== */

/* ===================== 1 + 2. CÔNG CỤ AI & LỜI DẶN AI ===================== */
const HUB_AI = (function(){
  // ---------- tiện ích ----------
  const R0 = v => (v==null || !isFinite(v)) ? null : Math.round(v);
  const R2 = v => (v==null || !isFinite(v)) ? null : Math.round(v*100)/100;
  const R4 = v => (v==null || !isFinite(v)) ? null : Math.round(v*10000)/10000;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const strip = s => String(s==null?"":s).replace(/<[^>]*>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g," ").trim();
  function rangeOf(a){
    a = a || {};
    if(a.from==="ALL" || a.to==="ALL") return {from:"", to:"", label:"toàn bộ dữ liệu"};
    const from = ISO.test(a.from||"") ? a.from : "", to = ISO.test(a.to||"") ? a.to : "";
    if(from || to) return {from, to: to || from, label:`${from||"…"} → ${to||from}`};
    const r = computeRange();
    return {from:r.from, to:r.to, label:"theo bộ lọc hiện tại của dashboard"};
  }
  function filterNote(){
    return {khu_vuc:F.region, kv_dia_ly:F.geo, dich_vu_pheu:F.funnel};
  }
  function pickActual(g){
    return { ten:g.name, chi_phi:R0(g.cost), data:R0(g.data), cpl:R0(g.cpl), sl_khach_hang:R0(g.slKhachHang),
      sl_khach_moi:R0(g.slKhachMoi), sl_khach_cu:R0(g.slKhachCu), gia_khach_moi:R0(g.giaKhachMoi),
      doanh_thu_google:R0(g.doanhThu), doanh_thu_khach_moi:R0(g.doanhThuKhachMoi), doanh_thu_khach_cu:R0(g.doanhThuKhachCu),
      roas_moi_tong:R2(g.roasNewNew), roas_tong:R2(g.roasTotal), cir:R4(g.cir) };
  }
  function pickKpi(k){
    return { kpi_chi_phi:R0(k.kpiCost), pct_chi_phi:R4(k.costPct), kpi_data:R0(k.kpiData), pct_data:R4(k.dataPct),
      kpi_cpl:R0(k.kpiCpl), kpi_khach_moi:R0(k.kpiKhachMoi), pct_khach_moi:R4(div(k.khachMoi,k.kpiKhachMoi)),
      kpi_doanh_so:R0(k.kpiRevenue), doanh_so_he_thong:R0(k.revenue), pct_doanh_so:R4(k.revenuePct),
      kpi_roas:R2(k.kpiRoas), kpi_cir:R4(k.kpiCir) };
  }
  const ACT_SORT = {chi_phi:"cost", data:"data", cpl:"cpl", sl_khach_moi:"slKhachMoi", gia_khach_moi:"giaKhachMoi", doanh_thu:"doanhThu", roas:"roasNewNew", cir:"cir"};

  // ---------- CÔNG CỤ (chạy ngay trên trình duyệt, dùng đúng hàm tính của dashboard) ----------
  const P_FROM = {type:"STRING", description:"Ngày bắt đầu YYYY-MM-DD. Bỏ trống = theo bộ lọc hiện tại của dashboard. 'ALL' = toàn bộ dữ liệu."};
  const P_TO   = {type:"STRING", description:"Ngày kết thúc YYYY-MM-DD (tính cả ngày này)."};
  const TOOLS = [
    {name:"tong_quan", description:"Tổng quan hệ thống trong 1 khoảng thời gian: thực đạt (chi phí, Data, CPL, khách mới, doanh thu Google, ROAS, CIR) và KPI kèm % hoàn thành.",
     parameters:{type:"OBJECT", properties:{from:P_FROM, to:P_TO}}},
    {name:"phan_ra", description:"Phân rã thực đạt theo khu vực, KV địa lý (chi nhánh TMV/PK) hoặc dịch vụ/phễu; có sắp xếp và giới hạn số dòng.",
     parameters:{type:"OBJECT", properties:{
       chieu:{type:"STRING", enum:["khu_vuc","kv_dia_ly","dich_vu"], description:"Chiều phân rã"},
       from:P_FROM, to:P_TO,
       sap_xep:{type:"STRING", enum:Object.keys(ACT_SORT), description:"Sắp xếp theo chỉ số"},
       tang_dan:{type:"BOOLEAN", description:"true = nhỏ → lớn (vd CPL rẻ nhất)"},
       gioi_han:{type:"INTEGER", description:"Số dòng tối đa (mặc định 15, tối đa 60)"}}, required:["chieu"]}},
    {name:"kpi_khu_vuc", description:"Đối chiếu KPI theo từng khu vực và phân loại: nên scale (đạt KPI Data + khách mới), cần tối ưu, cảnh báo (0 data hoặc 0 khách mới).",
     parameters:{type:"OBJECT", properties:{from:P_FROM, to:P_TO}}},
    {name:"so_sanh_ky_truoc", description:"So sánh khoảng thời gian với kỳ liền trước cùng độ dài (chi phí, Data, CPL, khách mới, doanh thu, ROAS). Cần from/to cụ thể.",
     parameters:{type:"OBJECT", properties:{from:P_FROM, to:P_TO}, required:["from","to"]}},
    {name:"canh_bao", description:"Danh sách cảnh báo đang mở của dashboard (KPI dưới ngưỡng, dịch vụ tiêu tiền 0 khách mới, khu vực giá khách mới đắt...).",
     parameters:{type:"OBJECT", properties:{from:P_FROM, to:P_TO}}},
    {name:"chien_dich", description:"Hiệu suất chiến dịch Google Ads (tab Chẩn đoán Chiến dịch): chi phí, ngân sách, lượt nhấp, hiển thị, chuyển đổi, CTR, CPC, CPA, tỷ lệ chuyển đổi. Gộp theo chiến dịch/tài khoản/loại/pháp nhân.",
     parameters:{type:"OBJECT", properties:{
       nhom_theo:{type:"STRING", enum:["chien_dich","tai_khoan","loai","phap_nhan"]},
       from:P_FROM, to:P_TO,
       sap_xep:{type:"STRING", enum:["chi_phi","chuyen_doi","cpa","ctr","cpc","luot_nhap","ty_le_chuyen_doi"]},
       tang_dan:{type:"BOOLEAN"},
       tu_khoa:{type:"STRING", description:"Lọc theo tên chứa từ khoá (không dấu cũng được)"},
       gioi_han:{type:"INTEGER", description:"Mặc định 15, tối đa 60"}}}},
    {name:"xu_huong", description:"Xu hướng theo ngày (≤ 93 ngày) hoặc theo tháng (khoảng dài hơn) của chi phí, Data, CPL, khách mới, doanh thu.",
     parameters:{type:"OBJECT", properties:{from:P_FROM, to:P_TO}}}
  ];

  const RUN = {
    tong_quan(a){
      const r = rangeOf(a);
      return {ky:r.label, from:r.from, to:r.to, bo_loc:filterNote(), thuc_dat:pickActual(actualSummary(r)), kpi:pickKpi(kpiSummary(r))};
    },
    phan_ra(a){
      const r = rangeOf(a), dim = a.chieu || "khu_vuc";
      let rows = dim==="dich_vu" ? actualRowsByFunnel(r) : dim==="kv_dia_ly" ? actualRowsByLoaiHinh(r) : actualRowsByRegion(r);
      const key = ACT_SORT[a.sap_xep] || "cost", asc = !!a.tang_dan;
      if(["cpl","giaKhachMoi","cir"].includes(key)) rows = rows.filter(x=>x[key]>0);
      rows = [...rows].sort((x,y)=> asc ? (x[key]||0)-(y[key]||0) : (y[key]||0)-(x[key]||0));
      const n = Math.max(1, Math.min(60, Number(a.gioi_han)||15));
      return {ky:r.label, chieu:dim, bo_loc:filterNote(), tong_so_dong:rows.length,
        dong:rows.slice(0,n).map(x=>Object.assign(pickActual(x), x.loaiHinh?{loai_hinh:x.loaiHinh}:{}))};
    },
    kpi_khu_vuc(a){
      const r = rangeOf(a), c = botClassifyRegions(r);
      const m = x => ({ten:x.name, chi_phi:R0(x.cost), data:R0(x.data), kpi_data:R0(x.kpiData), pct_data:R4(x._rData),
        sl_khach_moi:R0(x.slKhachMoi), kpi_khach_moi:R0(x.kpiKM), pct_khach_moi:R4(x._rKM),
        doanh_thu_google:R0(x.doanhThu), kpi_doanh_thu:R0(x.kpiRev), pct_doanh_thu:R4(x._rRev), cpl:R0(x.cpl), gia_khach_moi:R0(x.giaKhachMoi)});
      return {ky:r.label, bo_loc:filterNote(), nen_scale:c.scale.map(m), can_toi_uu:c.optimize.map(m), canh_bao:c.warn.map(m)};
    },
    so_sanh_ky_truoc(a){
      const r = rangeOf(a);
      if(!r.from || !r.to) return {loi:"Cần from và to cụ thể (YYYY-MM-DD) để so sánh kỳ trước."};
      const p = prevRange(r.from, r.to);
      return {ky_nay:{from:r.from,to:r.to, ...pickActual(actualSummary(r))}, ky_truoc:{from:p.from,to:p.to, ...pickActual(actualSummary(p))}, bo_loc:filterNote()};
    },
    canh_bao(a){
      const r = rangeOf(a);
      return {ky:r.label, bo_loc:filterNote(), canh_bao:collectAlerts(r).map(x=>({muc_do:x.sev==="high"?"cao":"theo dõi", tieu_de:strip(x.title), chi_tiet:strip(x.desc)}))};
    },
    chien_dich(a){
      const r = rangeOf(a), by = a.nhom_theo || "chien_dich";
      const field = {chien_dich:"name", tai_khoan:"taiKhoan", loai:"loai", phap_nhan:"phapNhan"}[by] || "name";
      const kw = a.tu_khoa ? norm(a.tu_khoa) : "";
      const map = new Map(); let dates = [];
      campaignRows.forEach(x=>{
        if(!dateInRange(x.date, r.from, r.to)) return;
        if(kw && !norm(x.name).includes(kw) && !norm(x.taiKhoan).includes(kw)) return;
        const k = x[field] || "(trống)";
        if(!map.has(k)) map.set(k, {ten:k, cost:0, budget:0, click:0, impr:0, conv:0, ngay:new Set()});
        const g = map.get(k); g.cost+=x.cost; g.budget+=x.budget; g.click+=x.click; g.impr+=x.impr; g.conv+=x.conv; g.ngay.add(x.date);
        dates.push(x.date);
      });
      let rows = [...map.values()].map(g=>({ten:g.ten, chi_phi:R0(g.cost), ngan_sach:R0(g.budget), luot_nhap:R0(g.click), hien_thi:R0(g.impr),
        chuyen_doi:R2(g.conv), ctr:R4(div(g.click,g.impr)), cpc:R0(div(g.cost,g.click)), cpa:R0(g.conv?g.cost/g.conv:null), ty_le_chuyen_doi:R4(div(g.conv,g.click)), so_ngay:g.ngay.size}));
      const key = a.sap_xep || "chi_phi", asc = !!a.tang_dan;
      if(["cpa","cpc","ctr","ty_le_chuyen_doi"].includes(key)) rows = rows.filter(x=>x[key]!=null && x[key]>0);
      rows.sort((x,y)=> asc ? (x[key]||0)-(y[key]||0) : (y[key]||0)-(x[key]||0));
      dates.sort();
      const n = Math.max(1, Math.min(60, Number(a.gioi_han)||15));
      return {ky:r.label, du_lieu_tu:dates[0]||null, du_lieu_den:dates[dates.length-1]||null, nhom_theo:by, tong_so_nhom:rows.length, dong:rows.slice(0,n)};
    },
    xu_huong(a){
      const r = rangeOf(a);
      const rows = actualRegion.filter(x=>passActualRegion(x, r));
      const days = new Set(rows.filter(x=>x.hasDay).map(x=>x.date));
      const byMonth = days.size > 93 || !days.size;
      const map = new Map();
      rows.forEach(x=>{
        const k = byMonth ? x.month : (x.hasDay ? x.date : null); if(!k) return;
        if(!map.has(k)) map.set(k, blankActual(k));
        addActual(map.get(k), x);
      });
      const out = [...map.values()].map(finalizeActual).sort((x,y)=>x.name<y.name?-1:1)
        .map(g=>({moc:g.name, chi_phi:R0(g.cost), data:R0(g.data), cpl:R0(g.cpl), sl_khach_moi:R0(g.slKhachMoi), doanh_thu_google:R0(g.doanhThu), roas_moi_tong:R2(g.roasNewNew)}));
      return {ky:r.label, don_vi:byMonth?"thang":"ngay", bo_loc:filterNote(), diem:out};
    }
  };


  // ---------- system prompt (gửi kèm mỗi lần, có bối cảnh dữ liệu hiện tại) ----------
  function systemPrompt(ctx){
    const addr = (ctx && ctx.address) || "bạn";
    const latest = botLatestDate() || "(chưa có dữ liệu theo ngày)";
    const cr = computeRange();
    const months = [...new Set(actualRegion.map(x=>x.month).filter(Boolean))].sort();
    const cDates = campaignRows.map(x=>x.date).filter(Boolean).sort();
    return [
      "Bạn là Trợ lý dữ liệu AI của dashboard \"Google Ads Performance Hub\" — hệ thống thẩm mỹ viện (TMV) & phòng khám (PK) Seoul Center. Vai trò: chuyên gia performance marketing cấp cao, phân tích sắc, đi thẳng vào việc.",
      `Xưng "mình", gọi người dùng là "${addr}". Luôn trả lời tiếng Việt, giữ nguyên thuật ngữ tiếng Anh (CPL, ROAS, CTR, CPC, CPA, CIR, KPI, Data...).`,
      "QUY TẮC SỐ LIỆU: mọi con số phải lấy từ công cụ (function). Không bịa, không ước đoán. Thiếu dữ liệu thì nói rõ là thiếu. Có thể gọi nhiều công cụ trước khi trả lời.",
      "Khi người dùng nói 'hôm nay/hôm qua/7 ngày qua/tháng này' → tính từ NGÀY DỮ LIỆU MỚI NHẤT (không phải ngày hệ thống) rồi truyền from/to dạng YYYY-MM-DD. Không nói thời gian → bỏ trống from/to (dùng bộ lọc hiện tại). 'Toàn bộ' → from='ALL'.",
      "ĐỊNH NGHĨA: chi_phi = chi phí Google Ads (VNĐ). Data = số lead/SĐT. CPL = chi phí/Data. gia_khach_moi = chi phí/SL khách mới. doanh_thu_google = doanh thu từ khách Google Ads (sheet tháng). doanh_so_he_thong = doanh số hệ thống trong sheet KPI — KHÁC doanh_thu_google, không được đánh đồng. roas_moi_tong = doanh thu khách mới/chi phí. cir = chi phí/doanh thu (càng thấp càng tốt). pct_* là tỷ lệ hoàn thành KPI (1 = 100%). Với CPL, CIR, giá khách mới: thấp hơn KPI là tốt.",
      "TRÌNH BÀY: ngắn gọn, ưu tiên gạch đầu dòng, in đậm số chính bằng **...**. Tiền viết dạng dễ đọc (vd 1,25 tỷ; 350 triệu; 185.000đ). Tỷ lệ dạng % 1 chữ số thập phân. KHÔNG dùng bảng markdown (khung chat hẹp). Khi phân tích: Kết luận → Số liệu chính → Nguyên nhân/điểm nghẽn → Đề xuất hành động cụ thể (scale, cắt giảm, tối ưu từ khoá/landing/ngân sách). Không cam kết kết quả tuyệt đối.",
      "THẺ SỐ LIỆU: khi trả lời có số liệu tổng quan, đặt NGAY SAU câu kết luận 1 dòng riêng đúng cú pháp [[KPI: Nhãn=Giá trị | Nhãn=Giá trị | Nhãn=Giá trị]] (3–4 ô, giá trị ngắn gọn, vd [[KPI: Chi phí=10,44 tỷ | CPL=356K ▲ | Khách mới=2.245 | ROAS=0,99]]; thêm ▲/▼ khi so sánh kỳ trước). Không lặp lại các số này thành gạch đầu dòng.",
      `BỐI CẢNH: Ngày hệ thống ${fmtDateLocal(new Date())}. Ngày dữ liệu mới nhất: ${latest}. Các tháng có dữ liệu: ${months.join(", ")||"(trống)"}. Dữ liệu chiến dịch: ${cDates.length?cDates[0]+" → "+cDates[cDates.length-1]:"(trống)"}.`,
      `BỘ LỌC ĐANG BẬT TRÊN DASHBOARD (các công cụ tự áp dụng bộ lọc khu vực/KV địa lý/dịch vụ này): thời gian ${cr.from||cr.to?(cr.from+" → "+cr.to):"toàn bộ"}; khu vực ${F.region}; KV địa lý ${F.geo}; dịch vụ/phễu ${F.funnel}. Nếu bộ lọc khác "Tất cả", nhắc người dùng số liệu đang bị lọc.`
    ].join("\n");
  }


  return { TOOLS, RUN, systemPrompt };
})();

/* ===================== 3. TRỢ LÝ QUY TẮC (dự phòng khi AI lỗi/hết quota) — chuyển từ index.html =====================
   TRỢ LÝ DỮ LIỆU (chatbot quy tắc — không cần API/internet, tái dùng toàn bộ
   hàm tính toán đã có sẵn: kpiSummary/actualSummary/collectAlerts/buildSectionIndex...
   để đảm bảo số liệu trả lời luôn khớp 100% với chính dashboard, không tính lại). */
let botLastAnalyzeSection=null;   // phần tử section vừa "đánh giá" gần nhất — để phát hiện hỏi dồn/phản bác

function botLatestDate(){
  const days=actualRegion.filter(r=>r.hasDay).map(r=>r.date).filter(Boolean).sort();
  return days.length ? days[days.length-1] : "";
}
// --- Giao diện chat do lõi ai-chat.js lo; các hàm cũ chuyển tiếp sang đó ---
function botScrollBottom(){ AIChat.scrollBottom(); }
function botAddBubble(html, sender){ return AIChat.addBubble(html, sender); }
function botAddChips(items){ AIChat.addChips(items); }
function botSend(text){ AIChat.send(text); }
function botAddLinkChip(container, label, targetId){
  const btn=document.createElement("button");
  btn.className="botLinkChip"; btn.textContent=label;
  btn.addEventListener("click", ()=>{
    const el=document.getElementById(targetId); if(!el) return;
    const sec=el.closest(".section"); if(!sec) return;
    const tabPanel=sec.closest(".tabPanel");
    const tabKey=tabPanel ? PANEL_TO_TAB[tabPanel.id] : null;
    const navBtn=tabKey ? document.querySelector(`.navItem[data-tab="${tabKey}"]`) : null;
    if(navBtn && !navBtn.classList.contains("active")) navBtn.click();
    setTimeout(()=>{
      sec.scrollIntoView({behavior:"smooth",block:"start"});
      sec.classList.add("sectionFlash");
      setTimeout(()=>sec.classList.remove("sectionFlash"),1700);
    },80);
  });
  container.appendChild(document.createElement("br"));
  container.appendChild(btn);
}

/* ---- Phân tích khoảng thời gian nhắc tới trong câu hỏi (độc lập với bộ lọc chung) ---- */
function botParseRange(nq){
  const latest=botLatestDate(); if(!latest) return null;
  if(/hom nay/.test(nq)) return {from:latest,to:latest,label:"hôm nay"};
  if(/hom qua/.test(nq)) return {from:addDaysISO(latest,-1),to:addDaysISO(latest,-1),label:"hôm qua"};
  if(/thang nay/.test(nq)){ const m=latest.slice(0,7); return {from:monthStartISO(m),to:monthEndISO(m),label:"tháng này"}; }
  if(/quy nay/.test(nq)){
    const y=Number(latest.slice(0,4)), mo=Number(latest.slice(5,7));
    const startM=Math.floor((mo-1)/3)*3+1;
    return {from:`${y}-${String(startM).padStart(2,"0")}-01`, to:monthEndISO(`${y}-${String(startM+2).padStart(2,"0")}`), label:"quý này"};
  }
  if(/nam nay/.test(nq)){ const y=latest.slice(0,4); return {from:`${y}-01-01`,to:`${y}-12-31`,label:"năm nay"}; }
  if(/toan bo|tat ca du lieu/.test(nq)) return {from:"",to:"",label:"toàn bộ dữ liệu"};
  const numMatch=nq.match(/(\d+)\s*ngay/);
  if(numMatch){ const n=Math.max(1,Math.min(365,Number(numMatch[1]))); return {from:addDaysISO(latest,-(n-1)),to:latest,label:`${n} ngày qua`}; }
  if(/tuan nay/.test(nq)) return {from:addDaysISO(latest,-6),to:latest,label:"7 ngày qua"};
  return null;
}
function botRangeOrCurrent(nq){
  const parsed=botParseRange(nq); if(parsed) return parsed;
  const r=computeRange();
  return {from:r.from, to:r.to, label:(r.from&&r.to)?`${formatDateVN(r.from)} → ${formatDateVN(r.to)}`:"toàn bộ dữ liệu (theo bộ lọc hiện tại)"};
}

const BOT_GLOSSARY={
  "cpl":"CPL (Cost Per Lead) = Chi phí ÷ Data (số lead thu được). CPL càng thấp càng tốt.",
  "roas":"ROAS (Return On Ad Spend) = Doanh thu ÷ Chi phí quảng cáo. ROAS > 1 nghĩa là đang có lời.",
  "cir":"CIR (Cost to Income Ratio) = Chi phí ÷ Doanh thu — càng thấp càng hiệu quả (ngược nghĩa ROAS).",
  "kpi":"KPI là chỉ tiêu mục tiêu đặt theo từng khu vực/tháng, dùng so sánh với Thực đạt để đánh giá hiệu suất.",
};

/* ---- Đánh giá section theo yêu cầu chat — CHỈ dùng số liệu/trạng thái ĐÃ CÓ SẴN trong chính
   dashboard (đọc lại + diễn đạt thành câu), KHÔNG bao giờ tự tính hay bịa thêm số liệu mới. ---- */
const BOT_INSIGHT_SELECTORS=["#taInsight","#weekdayInsight","#lmwInsight","#bhInsight","#fcInsight","#mktExcludedNote"];
function botFindInsightText(sec){
  for(const sel of BOT_INSIGHT_SELECTORS){
    const el=sec.querySelector(sel);
    if(el && el.textContent.trim().length>8) return el.textContent.trim();
  }
  const list=sec.querySelector("#bfInsightList");
  if(list){
    const items=[...list.querySelectorAll("li")].map(li=>li.textContent.trim()).filter(Boolean);
    if(items.length) return items.slice(0,3).join(" · ");
  }
  return null;
}
function botScanStatusBadges(sec){
  const badges=[...sec.querySelectorAll(".statusBadge, .assessBadge")];
  if(!badges.length) return null;
  const groups={good:[], watch:[], warn:[], bad:[]};
  badges.forEach(b=>{
    const cls = b.classList.contains("good")?"good" : b.classList.contains("bad")?"bad" : b.classList.contains("warn")?"warn" : b.classList.contains("watch")?"watch" : null;
    if(!cls) return;
    const tr=b.closest("tr");
    let name="";
    if(tr){ const firstCell=tr.querySelector("td,th"); if(firstCell) name=firstCell.textContent.replace(/[›▾▸▹◂◄→]/g,"").trim(); }
    groups[cls].push(name||"(không rõ tên)");
  });
  const total=Object.values(groups).reduce((a,g)=>a+g.length,0);
  if(!total) return null;
  const fmt=(label,arr)=> arr.length ? `<b>${label} (${arr.length}):</b> ${arr.slice(0,6).join(", ")}${arr.length>6?"…":""}` : null;
  const parts=[fmt("Tốt",groups.good), fmt("Cần theo dõi",groups.watch), fmt("Cần siết lại",groups.warn), fmt("Xấu/dừng lại",groups.bad)].filter(Boolean);
  return `Quét ${total} nhãn trạng thái đang hiển thị trong mục này:<br>${parts.join("<br>")}`;
}
function botCurrentFilterLabel(){
  const r=computeRange();
  return (r.from&&r.to) ? `${formatDateVN(r.from)} → ${formatDateVN(r.to)}` : "Toàn bộ dữ liệu";
}
/* tìm 1 dòng bảng có tên khớp gần đúng (vd "thẩm mỹ viện", "phòng khám", tên khu vực...) trong section,
   đọc lại NGUYÊN VĂN các ô đã hiển thị — không tính toán gì thêm, chỉ trích xuất số đã có sẵn trên màn hình */
function botFindTableRowText(sec, nameHint){
  const rows=[...sec.querySelectorAll("table tr")];
  const hint=norm(nameHint);
  for(const tr of rows){
    const firstCell=tr.querySelector("td,th");
    if(!firstCell) continue;
    if(norm(firstCell.textContent).includes(hint)){
      const cells=[...tr.querySelectorAll("td")].map(td=>td.textContent.replace(/[›▾▸▹◂◄→]/g,"").trim()).filter(Boolean);
      if(cells.length>1) return cells.slice(0,6).join(" · ");
    }
  }
  return null;
}
const BOT_ROWHINT_KEYWORDS=["thẩm mỹ viện","phòng khám","miền bắc","miền trung","miền tây","tây nguyên","hồ chí minh","đông nam bộ","campuchia"];
/* ============================================================================
   BÁO CÁO TOÀN DIỆN (chatbot) — phân loại khu vực + tìm nút thắt + tổng quan.
   TOÀN BỘ dùng số liệu thật (actualRowsByRegion/kpiMonthly đã có), phân loại theo
   ĐÚNG ngưỡng r>=1 "đạt KPI" đã dùng sẵn trong paMetricStatus (không bịa ngưỡng mới).
   Câu chữ là MẪU CỐ ĐỊNH ghép theo nhóm (giống cách ĐÁNH GIÁ PERFORMANCE ANALYST đang
   làm) — không phải AI tự luận câu riêng cho từng khu vực. ============================================================================ */
function botRegionKpiRow(region, range, actualRow){
  let kpiCost=0,kpiData=0,kpiKM=0,kpiRev=0;
  kpiMonthly.forEach(r=>{
    if(r.region!==region) return;
    if(!monthIntersects(r.month,range.from,range.to)) return;
    kpiCost+=r.kpiCost||0; kpiData+=r.kpiData||0; kpiKM+=r.kpiKhachMoi||0; kpiRev+=r.kpiRevenue||0;
  });
  return {...actualRow, kpiCost, kpiData, kpiKM, kpiRev};
}
function botClassifyRegions(range){
  const rows=actualRowsByRegion(range).map(r=>botRegionKpiRow(r.name, range, r));
  const scale=[], optimize=[], warn=[];
  rows.forEach(r=>{
    const rData = r.kpiData ? r.data/r.kpiData : null;
    const rKM   = r.kpiKM   ? r.slKhachMoi/r.kpiKM : null;
    const rRev  = r.kpiRev  ? r.doanhThu/r.kpiRev : null;
    r._rData=rData; r._rKM=rKM; r._rRev=rRev;
    if(r.slKhachMoi===0 || r.data===0){ warn.push(r); return; }               // không ra khách mới / không có data -> cảnh báo
    if(rData!==null && rKM!==null && rData>=1 && rKM>=1){ scale.push(r); return; } // đạt đủ KPI Data lẫn Khách mới (đúng ngưỡng paMetricStatus) -> nên scale
    optimize.push(r);                                                          // còn lại: có phát sinh nhưng chưa đạt đủ KPI -> cần tối ưu
  });
  return {scale, optimize, warn};
}
function botBottleneck(r){
  const parts=[{k:"Data",v:r._rData},{k:"Khách mới",v:r._rKM},{k:"Doanh thu",v:r._rRev}].filter(p=>p.v!==null);
  if(!parts.length) return null;
  parts.sort((a,b)=>a.v-b.v);
  return {weak:parts[0], strong:parts[parts.length-1]};
}
function botFullReport(range, addr){
  const s=actualSummary(range), kp=kpiSummary(range);
  const {scale, optimize, warn}=botClassifyRegions(range);
  const Addr=addr.charAt(0).toUpperCase()+addr.slice(1);

  let html=`<b>📊 Báo cáo toàn diện</b> — vai trò chuyên gia performance marketing (${range.label||botCurrentFilterLabel()}):<br><br>`;

  html+=`<b>Tổng quan:</b> Chi phí ${moneyCell(s.cost)}, Data ${dataCell(s.data)}, Khách mới ${dataCell(s.slKhachMoi)}, Doanh thu ${moneyCell(s.doanhThu)}`;
  if(s.data>0) html+=`, tỷ lệ Data→Khách mới ${pctCell(s.slKhachMoi/s.data)}`;
  html+=`.<br><br>`;

  if(scale.length){
    html+=`<b style="color:var(--green)">✅ Nhóm nên Scale (${scale.length}):</b><br>`;
    scale.forEach(r=>{
      html+=`• <b>${esc(r.name)}</b>: ${dataCell(r.data)} Data → ${dataCell(r.slKhachMoi)} KM · Giá KM ${moneyCell(r.giaKhachMoi)} — đạt đủ KPI Data &amp; Khách mới, có thể tăng ngân sách theo nhịp nhỏ và theo dõi Giá KM sau khi tăng.<br>`;
    });
    html+=`<br>`;
  }
  if(optimize.length){
    html+=`<b style="color:var(--yellow-dk)">⚠ Nhóm cần tối ưu (${optimize.length}):</b><br>`;
    optimize.forEach(r=>{
      const bn=botBottleneck(r);
      let note="có phát sinh nhưng chưa đạt đủ KPI.";
      if(bn){
        const strongGood = bn.strong.v>=1;
        const strongPhrase = strongGood
          ? `đang tốt ở <b>${bn.strong.k}</b> (đạt ${pctCell(bn.strong.v)} KPI)`
          : `khá hơn ở <b>${bn.strong.k}</b> (${pctCell(bn.strong.v)} KPI — vẫn chưa đạt) so với`;
        note = strongGood
          ? `${strongPhrase} nhưng chỉ đạt <b>${pctCell(bn.weak.v)} KPI ${bn.weak.k}</b> — đây là nút thắt cần gỡ trước khi tăng ngân sách.`
          : `${strongPhrase} <b>${bn.weak.k}</b> (chỉ ${pctCell(bn.weak.v)} KPI) — cả 2 đều chưa đạt mục tiêu, cần cải thiện đồng thời trước khi cân nhắc tăng ngân sách.`;
      }
      html+=`• <b>${esc(r.name)}</b>: ${dataCell(r.data)} Data → ${dataCell(r.slKhachMoi)} KM · Giá KM ${moneyCell(r.giaKhachMoi)} — ${note}<br>`;
    });
    html+=`<br>`;
  }
  if(warn.length){
    html+=`<b style="color:var(--red)">🚫 Nhóm cảnh báo (${warn.length}):</b><br>`;
    warn.forEach(r=>{
      html+=`• <b>${esc(r.name)}</b>: ${moneyCell(r.cost)} chi phí, ${dataCell(r.data)} Data, <b>0 khách mới</b> — không scale cho đến khi cải thiện chuyển đổi hoặc xác định lại nguồn data.<br>`;
    });
    html+=`<br>`;
  }

  html+=`<b>→ Hành động ưu tiên:</b><br>`;
  const actions=[];
  if(scale.length) actions.push(`Ưu tiên tăng ngân sách có kiểm soát cho <b>${esc(scale[0].name)}</b> (đang đạt đủ KPI), tăng theo nhịp nhỏ để kiểm tra khả năng mở rộng.`);
  if(optimize.length){
    const worst=[...optimize].sort((a,b)=>(a._rKM??1)-(b._rKM??1))[0];
    if(worst) actions.push(`Rà soát chất lượng lead &amp; tốc độ gọi lại ở <b>${esc(worst.name)}</b> trước khi bơm thêm ngân sách.`);
  }
  if(warn.length){
    const biggestWarnCost=[...warn].sort((a,b)=>b.cost-a.cost)[0];
    if(biggestWarnCost && biggestWarnCost.cost>0) actions.push(`Kiểm tra ngay <b>${esc(biggestWarnCost.name)}</b> — đang tiêu ${moneyCell(biggestWarnCost.cost)} nhưng 0 khách mới.`);
  }
  if(!scale.length) actions.push(`Chưa có khu vực nào đạt đủ điều kiện scale theo ngưỡng KPI hiện tại.`);
  actions.forEach(a=> html+=`• ${a}<br>`);

  html+=`<br><span style="color:var(--muted);font-size:10.5px">📅 Khoảng thời gian: ${range.label||botCurrentFilterLabel()} · Phân loại dựa trên ngưỡng "đạt ≥100% KPI" đã dùng sẵn trong dashboard, không phải AI tự suy luận riêng cho từng khu vực.</span>`;
  return html;
}

function botAnalyzeSection(sec, title, addr, rawQuery){
  const nq=norm(rawQuery||"");
  const Addr=addr.charAt(0).toUpperCase()+addr.slice(1);
  const filterNote=`<br><span style="color:var(--muted);font-size:10.5px">📅 Số liệu đang phản ánh đúng bộ lọc thời gian hiện tại của dashboard: <b>${botCurrentFilterLabel()}</b>. Muốn xem tháng/khoảng khác, ${addr} đổi bộ lọc ở thanh bên trái rồi hỏi lại — mình không tự đổi được bộ lọc qua chat.</span>`;
  // phát hiện câu hỏi nhắc 1 tháng cụ thể nhưng bộ lọc dashboard hiện KHÔNG khớp tháng đó -> cảnh báo rõ, tránh hiểu lầm số liệu sai
  const monthMatch=nq.match(/thang\s*(\d{1,2})/);
  let mismatchNote="";
  if(monthMatch){
    const askedMonth=Number(monthMatch[1]);
    const curMonth=F.month!=="Tất cả" ? Number(F.month.slice(5,7)) : null;
    if(curMonth!==askedMonth){
      mismatchNote=`<br><span style="color:var(--yellow-dk);font-size:10.5px">⚠ ${Addr} hỏi về <b>tháng ${askedMonth}</b>, nhưng bộ lọc dashboard hiện tại KHÔNG đang set đúng tháng đó (đang là: ${botCurrentFilterLabel()}) — số liệu dưới đây <b>chưa chắc đúng tháng ${askedMonth}</b>. ${Addr} đổi bộ lọc "Tháng" = Tháng ${askedMonth} trước rồi hỏi lại để chắc chắn nhé.</span>`;
    }
  }
  const hint=BOT_ROWHINT_KEYWORDS.find(k=>nq.includes(norm(k)));
  if(hint){
    const rowText=botFindTableRowText(sec, hint);
    if(rowText){
      return `Với vai trò chuyên gia performance marketing, đây là số liệu <b>${esc(hint)}</b> trong mục <b>${esc(title)}</b> (đọc trực tiếp từ bảng, không tính lại):<br><br>${esc(rowText)}${mismatchNote}${filterNote}`;
    }
  }
  const insight=botFindInsightText(sec);
  if(insight){
    return `Với vai trò chuyên gia performance marketing, dựa trên nhận định dashboard đã tính sẵn cho <b>${esc(title)}</b>:<br><br>${esc(insight)}${mismatchNote}${filterNote}`;
  }
  const scan=botScanStatusBadges(sec);
  if(scan){
    return `Với vai trò chuyên gia performance marketing, mình xem qua <b>${esc(title)}</b>:<br><br>${scan}${mismatchNote}${filterNote}`;
  }
  return `Mục <b>${esc(title)}</b> hiện <b>chưa có sẵn phân tích/nhãn trạng thái tự động</b> trong dashboard, nên mình xin phép không tự suy diễn để tránh đưa nhận định sai lệch ${addr} nhé. ${Addr} có thể xem trực tiếp số liệu trong mục này, hoặc hỏi mình 1 chỉ số cụ thể (Chi phí/CPL/ROAS/Doanh thu...) mình tra cứu chính xác ngay.`;
}

function botHandle(raw){
  const nq=norm(raw);

  const addr=AIChat.address()||"bạn";

  if(/^(cam on|thanks|thank you|^ok$|^oke$)/.test(nq.trim())){
    botAddBubble(`Dạ không có gì ${addr}! Cần hỏi gì thêm cứ nhắn mình nhé.`,"bot"); return;
  }

  for(const key in BOT_GLOSSARY){
    if(nq.includes(key+" la gi") || nq===key){
      botAddBubble(`<b>${key.toUpperCase()}</b> — ${BOT_GLOSSARY[key]}`,"bot"); return;
    }
  }

  if(/tim (kiem )?(section|muc|phan)|section nao|phan nao co|muc nao co/.test(nq)){
    const idx=buildSectionIndex();
    const stop=["tim","kiem","section","muc","phan","o","dau","nao","co","cho","toi","minh","giup","the","ban","theo","trong","cua","va","la","gi","hay","giup","xem","hien","thi","di","toi"];
    // ưu tiên 1: khớp nguyên cụm từ liên tiếp (bỏ các từ khóa lệnh "tìm section...") -> chính xác nhất
    const query = nq.replace(/tim (kiem )?(section|muc|phan)( nay)?/,"").trim();
    let matches = query ? idx.filter(it=>it.norm.includes(query)) : [];
    // ưu tiên 2: nếu không khớp nguyên cụm, chấm điểm theo SỐ TỪ khớp (nhiều từ khớp hơn = liên quan hơn), không lấy bừa theo thứ tự DOM
    if(!matches.length){
      const words=nq.split(/\s+/).filter(w=>w && !stop.includes(w));
      if(words.length){
        const scored = idx.map(it=>({it, score: words.filter(w=>it.norm.includes(w)).length})).filter(x=>x.score>0);
        scored.sort((a,b)=>b.score-a.score);
        matches = scored.map(x=>x.it);
      }
    }
    if(!matches.length) matches=idx;
    matches=matches.slice(0,5);
    botAddBubble(`Mình tìm được ${matches.length} section liên quan, bấm để mình đưa ${addr} tới đó ngay:`,"bot");
    botAddChips(matches.map(it=>({
      label:`${it.title} (${it.tabLabel})`,
      action:()=>{ goToSection(it); botAddBubble(`Đã mở section <b>${esc(it.title)}</b> ở tab ${esc(it.tabLabel)} rồi ${addr} nhé.`,"bot"); }
    })));
    return;
  }

  if(/canh bao|dang mo|van de gi|rui ro|bat thuong/.test(nq)){
    const range=botRangeOrCurrent(nq);
    const alerts=collectAlerts(range);
    if(!alerts.length){ botAddBubble(`Hiện tại (${range.label}) mình không thấy cảnh báo nào đang mở — mọi chỉ số trong ngưỡng an toàn ${addr} nhé! ✅`,"bot"); return; }
    let html=`Đang có <b>${alerts.length} cảnh báo</b> (${range.label}):<br><br>`;
    alerts.slice(0,5).forEach((a,i)=>{ html+=`${i+1}. <b>${esc(a.title)}</b><br><span style="color:var(--muted)">${esc(a.desc)}</span><br><br>`; });
    const bubble=botAddBubble(html,"bot");
    if(alerts[0].target) botAddLinkChip(bubble, "Xem chi tiết cảnh báo đầu tiên →", alerts[0].target);
    return;
  }

  // Kiểm tra CTR / chiến dịch cụ thể TRƯỚC nhánh Top N — vì câu dạng "CTR chiến dịch nào cao nhất"
  // cũng chứa từ khóa "cao nhất" nên phải chặn ở đây trước, tránh rơi nhầm vào xếp hạng theo Chi phí.
  if(/\bctr\b/.test(nq) || /chien dich/.test(nq)){
    botAddBubble(`Mình xin lỗi ${addr}, dữ liệu nguồn hiện tại <b>không có cột CTR</b> và <b>không có breakdown theo tên từng chiến dịch cụ thể</b> — chỉ có ở cấp Khu vực / KV Địa lý (chi nhánh) / Dịch vụ-Phễu. ${addr.charAt(0).toUpperCase()+addr.slice(1)} muốn xem theo cấp nào thay thế?`,"bot");
    botAddChips([
      {label:"Xem theo Khu vực", action:()=>botSend("Top 5 khu vực chi phí cao nhất")},
      {label:"Xem theo KV Địa lý", action:()=>botSend("Top 5 kv dia ly chi phi cao nhat")},
      {label:"Xem theo Dịch vụ", action:()=>botSend("Top 5 dich vu chi phi cao nhat")},
    ]);
    return;
  }

  const topMatch=nq.match(/top\s*(\d+)?|cao nhat|thap nhat|re nhat|dat nhat/);
  if(topMatch){
    const nRaw=topMatch[1];
    const n=nRaw?Math.max(1,Math.min(10,Number(nRaw))):5;
    const byService=/dich vu|pheu/.test(nq);
    const byLoaiHinh=/kv dia ly|chi nhanh/.test(nq);
    const range=botRangeOrCurrent(nq);
    let rows = byService ? actualRowsByFunnel(range) : (byLoaiHinh ? actualRowsByLoaiHinh(range) : actualRowsByRegion(range));
    let metricKey="cost", metricLabel="Chi phí", fmt=moneyCell, asc=false;
    if(/cpl/.test(nq)){ metricKey="cpl"; metricLabel="CPL"; asc=/re nhat|thap nhat/.test(nq) || !/dat nhat|cao nhat/.test(nq); }
    else if(/roas/.test(nq)){ metricKey="roasNewNew"; metricLabel="ROAS (Mới/Tổng)"; fmt=v=>Number(v).toFixed(2); asc=/thap nhat/.test(nq); }
    else if(/doanh thu/.test(nq)){ metricKey="doanhThu"; metricLabel="Doanh thu"; asc=/thap nhat/.test(nq); }
    else if(/khach moi/.test(nq)){ metricKey="slKhachMoi"; metricLabel="SL khách mới"; fmt=dataCell; asc=/thap nhat/.test(nq); }
    else if(/\bdata\b/.test(nq)){ metricKey="data"; metricLabel="Data"; fmt=dataCell; asc=/thap nhat/.test(nq); }
    else if(/chi phi/.test(nq)){ metricKey="cost"; metricLabel="Chi phí"; asc=/thap nhat/.test(nq); }
    else { asc=/thap nhat|re nhat/.test(nq); }
    rows=rows.filter(r=>isFinite(r[metricKey]) && r.cost>0);
    rows.sort((a,b)=> asc ? a[metricKey]-b[metricKey] : b[metricKey]-a[metricKey]);
    const top=rows.slice(0,n);
    if(!top.length){ botAddBubble(`Mình chưa tìm thấy dữ liệu phù hợp trong khoảng ${range.label} ${addr} ơi.`,"bot"); return; }
    let html=`Top ${top.length} theo <b>${metricLabel}</b> (${range.label}):<br><br>`;
    top.forEach((r,i)=>{ html+=`<div class="botRankRow"><span>${i+1}. ${esc(r.name)}</span><b>${fmt(r[metricKey])}</b></div>`; });
    botAddBubble(html,"bot");
    return;
  }

  if(/so voi ky truoc|tang giam|bien dong|so sanh/.test(nq)){
    const range=botRangeOrCurrent(nq);
    if(!range.from||!range.to){ botAddBubble(`Để so sánh kỳ trước, ${addr} cho mình biết khoảng thời gian cụ thể nhé (vd "7 ngày qua", "tháng này"...).`,"bot"); return; }
    const prev=prevRange(range.from,range.to);
    const s=actualSummary(range), sp=actualSummary(prev);
    const chg=(a,b)=> b? ((a-b)/b*100) : null;
    const fmtChg=v=> v===null?"—":(v>=0?"▲ ":"▼ ")+Math.abs(v).toFixed(1)+"%";
    let html=`So sánh <b>${range.label}</b> với kỳ liền trước (${formatDateVN(prev.from)}→${formatDateVN(prev.to)}):<br><br>`;
    html+=`<div class="botRankRow"><span>Chi phí</span><b>${moneyCell(s.cost)} (${fmtChg(chg(s.cost,sp.cost))})</b></div>`;
    html+=`<div class="botRankRow"><span>Data</span><b>${dataCell(s.data)} (${fmtChg(chg(s.data,sp.data))})</b></div>`;
    html+=`<div class="botRankRow"><span>Khách mới</span><b>${dataCell(s.slKhachMoi)} (${fmtChg(chg(s.slKhachMoi,sp.slKhachMoi))})</b></div>`;
    html+=`<div class="botRankRow"><span>Doanh thu</span><b>${moneyCell(s.doanhThu)} (${fmtChg(chg(s.doanhThu,sp.doanhThu))})</b></div>`;
    botAddBubble(html,"bot");
    return;
  }

  const metricAsk=[
    {re:/chi phi/, key:"cost", label:"Chi phí", fmt:moneyCell, kpiKey:"kpiCost"},
    {re:/\bcpl\b|gia data/, key:"cpl", label:"CPL (Giá Data)", fmt:moneyCell, kpiKey:"kpiCpl"},
    {re:/roas/, key:"roasNewNew", label:"ROAS (Mới/Tổng)", fmt:v=>Number(v).toFixed(2), kpiKey:"kpiRoas"},
    {re:/doanh thu/, key:"doanhThu", label:"Doanh thu", fmt:moneyCell, kpiKey:"kpiRevenue"},
    {re:/khach moi/, key:"slKhachMoi", label:"SL khách mới", fmt:dataCell, kpiKey:"kpiKhachMoi"},
    {re:/\bdata\b/, key:"data", label:"Data", fmt:dataCell, kpiKey:"kpiData"},
    {re:/gia khach moi/, key:"giaKhachMoi", label:"Giá khách mới", fmt:moneyCell, kpiKey:null},
    {re:/\bcir\b/, key:"cir", label:"CIR", fmt:v=>(Number(v)*100).toFixed(1)+"%", kpiKey:null},
  ];
  const found=metricAsk.find(m=>m.re.test(nq));
  if(found){
    const range=botRangeOrCurrent(nq);
    const s=actualSummary(range), kp=kpiSummary(range);
    let html=`<b>${found.label}</b> (${range.label}): <b>${found.fmt(s[found.key])}</b>`;
    if(found.kpiKey && kp[found.kpiKey]){
      const ratio=s[found.key]/kp[found.kpiKey];
      html+=`<br><span style="color:var(--muted)">So với KPI (${found.fmt(kp[found.kpiKey])}): đạt ${(ratio*100).toFixed(0)}%</span>`;
    }
    // Ghi chú thông minh: nếu Chi phí=0 nhưng Data>0 trong khoảng ngắn (vd "hôm nay") -> nhiều khả năng
    // do dữ liệu Chi phí của ngày gần nhất chưa kịp đồng bộ (Data thường cập nhật nhanh hơn Chi phí),
    // không phải thực sự không chạy quảng cáo. Giúp người dùng không hiểu nhầm là lỗi hệ thống.
    if(found.key==="cost" && s.cost===0 && s.data>0 && range.from===range.to){
      html+=`<br><span class="botHint">⚠ Lưu ý: Data đã ghi nhận ${dataCell(s.data)} nhưng Chi phí đang là 0 — nhiều khả năng dữ liệu Chi phí của ngày này <b>chưa kịp đồng bộ</b> (Data thường cập nhật nhanh hơn Chi phí 1 nhịp), chứ không hẳn là không chạy quảng cáo. ${addr.charAt(0).toUpperCase()+addr.slice(1)} thử hỏi lại "chi phí hôm qua" để đối chiếu nhé.</span>`;
    }
    botAddBubble(html,"bot");
    return;
  }

  // Nhánh "đánh giá/phân tích/nhận xét" mở rộng — đặt CUỐI CÙNG (sau mọi nhánh tra cứu cụ thể) để không
  // "nuốt" nhầm các câu hỏi đã có câu trả lời chính xác hơn (vd "đánh giá CPL hôm nay" nên đi vào tra cứu số
  // ở nhánh phía trên). Bắt được cả câu không có chữ "section này" (vd "đánh giá giúp tôi hiệu suất tháng này
  // cho nhóm thẩm mỹ viện") miễn là đang có 1 section đã mở qua chat/thanh tìm kiếm.
  if(/phan tich toan dien|bao cao tong quan|bao cao ceo|nhom nao nen scale|danh gia toan he thong|phan loai khu vuc|nhom can toi uu/.test(nq)){
    const range=botRangeOrCurrent(nq);
    botAddBubble(botFullReport(range, addr), "bot");
    return;
  }

  if(/danh gia|phan tich|nhan xet/.test(nq)){
    const ctx=window.botLastSection;
    if(!ctx || !ctx.el || !document.body.contains(ctx.el)){
      botAddBubble(`${addr.charAt(0).toUpperCase()+addr.slice(1)} chưa "mở" section nào qua mình hoặc qua thanh tìm kiếm cả — ${addr} tìm 1 section trước nhé (vd "tìm section hiệu suất theo thứ trong tuần"), rồi hỏi lại "đánh giá section này" mình sẽ xem ngay.`,"bot");
      return;
    }
    // phát hiện câu hỏi dồn/phản bác ("là đánh giá chưa", "chưa rõ", "cụ thể hơn"...) sau khi đã đưa ra
    // đúng 1 câu trả lời rồi -> KHÔNG lặp lại y hệt, mà nói thẳng giới hạn thay vì giả vờ hiểu sâu hơn.
    const isPushback=/la danh gia chua|chua ro|chua du|chua dung|khong dung|cu the hon|ro hon|dung ma|that su|the la xong|the thoi a/.test(nq);
    const hasNewHint=BOT_ROWHINT_KEYWORDS.some(k=>nq.includes(norm(k)));
    if(isPushback && botLastAnalyzeSection===ctx.el && !hasNewHint){
      const Addr=addr.charAt(0).toUpperCase()+addr.slice(1);
      botAddBubble(`${Addr} nói đúng, đây thực sự chỉ là mức phân tích tối đa mình làm được ${addr} ạ 🙏 — trợ lý này chạy bằng <b>quy tắc cố định</b> (không phải AI thật), nên chỉ tổng hợp lại đúng số/nhãn dashboard đã tính sẵn, chứ không tự suy luận sâu hơn hay trả lời được các câu hỏi xoáy tiếp theo như "vì sao", "nên làm gì". Muốn có mức phân tích chuyên gia thật sự linh hoạt, sẽ cần nâng cấp lên AI thật (mình từng trao đổi việc này với ${addr}). Trong lúc đó, ${addr} hỏi mình 1 chỉ số thật cụ thể (vd "CPL tháng 8 khu vực Miền Bắc") mình tra đúng số liệu ngay nhé.`,"bot");
      return;
    }
    botLastAnalyzeSection=ctx.el;
    botAddBubble(botAnalyzeSection(ctx.el, ctx.title, addr, raw),"bot");
    return;
  }

  botAddBubble(`Mình chưa chắc hiểu ý ${addr} lắm 🤔. Mình trả lời được các dạng câu hỏi sau — ${addr} thử xem:`,"bot");
  botShowSuggestions();
}

function botShowSuggestions(){
  botAddChips([
    {label:"Phân tích toàn diện", action:()=>botSend("Phân tích toàn diện")},
    {label:"Chi phí hôm nay là bao nhiêu?", action:()=>botSend("Chi phí hôm nay là bao nhiêu?")},
    {label:"Top 5 khu vực CPL rẻ nhất", action:()=>botSend("Top 5 khu vực CPL rẻ nhất")},
    {label:"Có cảnh báo nào đang mở không?", action:()=>botSend("Có cảnh báo nào đang mở không?")},
    {label:"So sánh 7 ngày qua với kỳ trước", action:()=>botSend("So sánh 7 ngày qua với kỳ trước")},
    {label:"Tìm section Hiệu suất khu vực", action:()=>botSend("Tìm section Hiệu suất khu vực")},
  ]);
}

/* ===================== 4. GẮN VÀO LÕI AI CHAT ===================== */
AIChat.init({
  title: "Trợ lý dữ liệu",
  subtitle: "Đang hoạt động · Gemini",
  placeholder: "Hỏi về chi phí, CPL, ROAS, cảnh báo...",
  launcherText: "Hỏi AI số liệu",
  welcomeTitle: "Xin chào 👋 Mình là trợ lý dữ liệu Google Ads",
  welcomeText: "Mình đọc trực tiếp số liệu đang hiển thị trên dashboard (theo bộ lọc hiện tại) và phân tích như chuyên gia performance — <b>chi phí, CPL, khách mới, ROAS, cảnh báo, chiến dịch</b>.",
  quickActions: [
    {icon:"📊", bg:"rgba(26,115,232,.12)", title:"Phân tích toàn diện", desc:"Tổng quan + đề xuất", q:"Phân tích toàn diện theo bộ lọc hiện tại"},
    {icon:"⚠️", bg:"rgba(217,48,37,.12)", title:"Cảnh báo đang mở", desc:"KPI dưới ngưỡng", q:"Có cảnh báo nào đang mở không? Ưu tiên xử lý gì trước?"},
    {icon:"🏆", bg:"rgba(30,158,87,.12)", title:"Top khu vực", desc:"CPL rẻ, ROAS cao", q:"Top 5 khu vực CPL rẻ nhất và ROAS cao nhất"},
    {icon:"📈", bg:"rgba(124,58,237,.12)", title:"So với kỳ trước", desc:"7 ngày gần nhất", q:"So sánh 7 ngày qua với kỳ trước"}
  ],
  suggestions: ["Vì sao CPL tăng?", "Top 5 chiến dịch tốn tiền nhất", "Khu vực nào nên scale?", "Dịch vụ nào tiêu tiền 0 khách mới?", "Xu hướng chi phí tháng này"],
  toolLabels: {
    tong_quan: "Tra cứu tổng quan KPI", phan_ra: "Phân rã theo khu vực / dịch vụ", kpi_khu_vuc: "Đối chiếu KPI theo khu vực",
    so_sanh_ky_truoc: "So sánh với kỳ trước", canh_bao: "Kiểm tra cảnh báo", chien_dich: "Tra cứu hiệu suất chiến dịch", xu_huong: "Xem xu hướng theo ngày"
  },
  tools: HUB_AI.TOOLS,
  runTool: (name, args) => HUB_AI.RUN[name] ? HUB_AI.RUN[name](args) : undefined,
  systemPrompt: HUB_AI.systemPrompt,
  isReady: () => kpiMonthly.length > 0 || actualRegion.length > 0 || campaignRows.length > 0,
  getUrl: () => getAppsScriptUrl(),
  ruleHandle: (text) => botHandle(text),
  onOpen: () => { const mm = document.getElementById("miniMapPanel"); if(mm) mm.hidden = true; }   // tránh chồng với Mục lục
});
window.hubAgentTools = HUB_AI.RUN;   // kiểm tra nhanh trong Console: hubAgentTools.tong_quan({from:"ALL"})

/* ===================== 5. MỤC LỤC (mini-map) ĐỒNG BỘ VỚI NÚT CHAT =====================
   Nút Mục lục nằm NGAY TRÊN nút "Hỏi AI số liệu", thẳng hàng tâm; mở khung chat thì Mục lục ẩn đi
   (khung chat chiếm góc phải), đóng chat thì hiện lại. Mở Mục lục: tô sáng section đang xem. */
(function hubMiniMapDock(){
  const css = document.createElement("style");
  css.textContent = `
    @property --mm-ang{syntax:"<angle>";inherits:false;initial-value:0deg}
    @keyframes mmSpin{to{--mm-ang:360deg}}
    #miniMapFab{right:27px!important;bottom:94px!important;width:48px;height:48px;transition:opacity .2s,transform .15s,box-shadow .15s;
      border:0!important;color:#4f46e5!important;background:var(--card,#fff)!important;box-shadow:0 8px 22px rgba(79,70,229,.25)!important}
    #miniMapFab:hover{box-shadow:0 10px 26px rgba(79,70,229,.4)!important}
    /* Viền gradient chạy vòng quanh nút */
    #miniMapFab::before{content:"";position:absolute;inset:-1px;border-radius:50%;padding:2.5px;pointer-events:none;
      background:conic-gradient(from var(--mm-ang),#1a73e8,#4f46e5,#7c3aed,#22d3ee,#1a73e8);
      -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
      mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;
      filter:drop-shadow(0 0 4px rgba(99,102,241,.6));animation:mmSpin 3s linear infinite}
    .aic-open #miniMapFab{opacity:0;pointer-events:none;transform:scale(.8)}
    #miniMapPanel{right:22px!important;bottom:152px!important;border-radius:16px;padding:10px;width:290px}
    #miniMapPanel .miniMapHead span{background:var(--soft,#f3f6fb);padding:2px 8px;border-radius:99px}
    #miniMapPanel .miniMapList{counter-reset:mm}
    #miniMapPanel .miniMapItem{font-size:11.5px;line-height:1.35;align-items:flex-start;gap:9px}
    #miniMapPanel .miniMapItem .mmDot{width:auto;height:auto;background:none;border-radius:0;color:var(--muted,#6b7790);font-size:10.5px;font-weight:800;min-width:18px;padding-top:1px}
    #miniMapPanel .miniMapItem .mmDot::before{counter-increment:mm;content:counter(mm,decimal-leading-zero)}
    #miniMapPanel .miniMapItem.mmNow{background:rgba(26,115,232,.1);color:var(--blue,#1a73e8)}
    #miniMapPanel .miniMapItem.mmNow .mmDot{color:var(--blue,#1a73e8)}
    @media(max-width:520px){#miniMapFab{right:21px!important;bottom:86px!important}#miniMapPanel{right:16px!important;width:calc(100vw - 32px)}}
  `;
  document.head.appendChild(css);
  // Tô sáng section đang hiển thị trên màn hình khi mở Mục lục
  const fab = document.getElementById("miniMapFab");
  if(fab) fab.addEventListener("click", () => setTimeout(() => {
    const items = [...document.querySelectorAll("#miniMapList .miniMapItem")];
    if(!items.length || typeof buildSectionIndex !== "function") return;
    const tab = (document.querySelector(".navItem.active") || {}).dataset;
    const secs = buildSectionIndex().filter(it => it.tabKey === (tab ? tab.tab : "overview"));
    let best = -1, bestTop = -Infinity;
    secs.forEach((it, i) => { const t = it.el.getBoundingClientRect().top; if(t <= 140 && t > bestTop){ bestTop = t; best = i; } });
    if(best < 0) best = 0;
    items.forEach((el, i) => el.classList.toggle("mmNow", i === best));
    const cur = items[best]; if(cur) cur.scrollIntoView({block:"nearest"});
  }, 0));
})();
