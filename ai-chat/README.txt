AI CHAT — TRỢ LÝ DỮ LIỆU DÙNG CHUNG (71 ADS)
============================================
Thư mục này đặt CẠNH index.html của dashboard:
  dashboard/
  ├── index.html
  └── ai-chat/
      ├── ai-chat.css     giao diện khung chat (dùng chung mọi dashboard)
      ├── ai-chat.js      lõi: khung chat, gọi Apps Script → Gemini, vòng lặp AI Agent, dự phòng (dùng chung)
      ├── hub-tools.js    RIÊNG Performance Hub: công cụ tra số liệu + lời dặn AI + trợ lý quy tắc cũ
      └── README.txt

index.html chỉ cần 3 dòng, đặt trước </body> (sau script chính và khối Firebase):
  <link rel="stylesheet" href="ai-chat/ai-chat.css">
  <script src="ai-chat/ai-chat.js"></script>
  <script src="ai-chat/hub-tools.js"></script>

SỬA Ở ĐÂU
- Màu / kích thước / vị trí khung chat ........ ai-chat.css
- Cách AI trả lời, tính năng chung ............ ai-chat.js  (sửa xong copy sang các dashboard khác)
- Công cụ số liệu, lời dặn AI, câu chào, gợi ý  hub-tools.js
- Model Gemini, API key, giới hạn lượt hỏi .... Apps Script (Script Properties + Code.gs)

NHÂN BẢN CHO DASHBOARD KHÁC (vd Report Thương Hiệu)
1. Copy ai-chat.css + ai-chat.js sang thư mục ai-chat/ của dashboard đó (không sửa gì).
2. Tạo file công cụ riêng (vd brand-tools.js), cuối file gọi:
     AIChat.init({
       title, subtitle, placeholder, launcherText: "Hỏi AI số liệu",
       welcomeTitle, welcomeText, quickActions: [{icon, bg, title, desc, q}],
       suggestions: [...], toolLabels: {ten_cong_cu: "Nhãn bước"},
       tools: [...khai báo công cụ...], runTool: (name, args) => {...},
       systemPrompt: ({address}) => "lời dặn AI...",
       isReady: () => true khi đã có dữ liệu,
       getUrl: () => URL Apps Script /exec của dashboard đó,
       ruleHandle: (text) => {...}   // tuỳ chọn: trợ lý dự phòng
     });
   (Nhờ Claude viết file này theo dữ liệu của dashboard.)
3. Apps Script của dashboard đó: thêm nhánh action 'chat' + hàm geminiChat_ (copy từ Code.gs của Hub)
   và thuộc tính GEMINI_API_KEY. Dashboard phải dùng đăng nhập Firebase (window.kwFirebase).
4. Thêm 3 dòng <link>/<script> vào index.html.

LƯU Ý
- Không bao giờ dán API key Gemini vào các file này — key chỉ nằm trong Apps Script.
- Đưa lên GitHub phải đẩy cả thư mục ai-chat/, thiếu thì nút chat không hiện.
- Kiểm tra nhanh trong Console (F12): AIChat.version (2.1), hubAgentTools.tong_quan({from:"ALL"})
