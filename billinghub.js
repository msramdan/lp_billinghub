// ==============================
// KONFIGURASI API
// ==============================
const API_CONFIG = {
  baseUrl: "https://billinghub.id/api",
  token: "6UUCTOYWf50VJHU9PrUTHtJFamNgtDIl8Jkmg0kwWQ7ph5Xk4xPKAWFhT6VvNtcE",
};

// ==============================
// STATE GLOBAL
// ==============================
let vouchers = [];
let selectedVoucher = null;
let settingData = null;
let companyData = null;
let savedVoucherForAutoLogin = null;

// State untuk paket
let currentPackageId = null;

// Daftar metode pembayaran (Tripay / Qrin; diisi setelah getPaymentMethods)
let paymentMethodsList = [];

// Metode yang dipilih user (code saluran)
let selectedPaymentMethodCode = null;

function isQrinPaymentGateway() {
  const g = companyData && companyData.payment_gateway;
  return g === "Qrin Payment Gateway" || g === "Qrin";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Untuk atribut HTML (mis. src gambar) — jangan encode & agar URL Tripay/Qrin tetap valid */
function escapeAttr(str) {
  return String(str ?? "").replace(/"/g, "&quot;");
}

function methodFeeAmount(m) {
  if (m == null) return 0;
  if (typeof m.customer_cost === "number") return m.customer_cost;
  if (m.customer_cost != null && m.customer_cost !== "") {
    const n = parseInt(String(m.customer_cost), 10);
    return isNaN(n) ? 0 : n;
  }
  const fc = m.fee_customer;
  if (fc && typeof fc.flat === "number") return fc.flat;
  const flat = m.fee_flat || m.fee_percent || 0;
  const n = parseInt(String(flat), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Pembulatan ke Rp penuh: bagian desimal < 0,5 ke bawah, ≥ 0,5 ke atas (contoh: 100,4→100, 100,5→101).
 */
function roundRpQrisPercentPart(amount) {
  const x = Number(amount);
  if (!Number.isFinite(x) || x <= 0) return 0;
  const intPart = Math.floor(x);
  const frac = x - intPart;
  if (frac < 0.5) return intPart;
  return intPart + 1;
}

/**
 * Biaya admin QRIS (sama seperti contoh manual): **dulu** nominal + Rp 750, **baru** tambah 0,7% × (nominal + 750),
 * dengan bagian persen dibulatkan ke Rp penuh. Setara: total bayar = (nominal + 750) + pembulatan(0,007 × (nominal + 750)).
 */
function computeQrinQrisAdminFeeRp(nominal) {
  const n = Math.max(0, Math.floor(Number(nominal) || 0));
  const flat = 750;
  const subtotal = n + flat;
  const rawPct = (subtotal * 7) / 1000;
  const pctPart = roundRpQrisPercentPart(rawPct);
  const total = flat + pctPart;
  return { flat, pctPart, total, totalBayar: n + total };
}

/** Dipanggil setelah order Qrin sukses — dipakai ringkasan modal QR & VA */
function setQrinOrderFeeSummaryFromPurchase(data) {
  const nominal = Math.round(Number(data.amount)) || 0;
  const method = paymentMethodsList.find(
    (m) => String(m.code || m.channel_code || "") === String(selectedPaymentMethodCode || "")
  );
  let adminRp = 0;
  if (method && isQrinQrisMethodRow(method)) {
    adminRp = computeQrinQrisAdminFeeRp(nominal).total;
  } else if (method) {
    adminRp = methodFeeAmount(method);
  }
  window._qrinOrderFeeSummary = {
    nominal,
    adminRp,
    totalRp: nominal + adminRp,
  };
}

/** Ringkasan: Nominal, Biaya admin (satu angka), Total pembayaran — tanpa rumus detail */
function buildQrinOrderSummaryHtml(data) {
  const fs = window._qrinOrderFeeSummary;
  const hasAmt = data.amount != null && !isNaN(Number(data.amount));
  const nominal = hasAmt
    ? fs
      ? fs.nominal
      : Math.round(Number(data.amount)) || 0
    : 0;
  const adminRp = fs ? fs.adminRp : 0;
  const totalRp = fs ? fs.totalRp : nominal + adminRp;
  const val = data.validity ? String(data.validity) : "";
  const storeId =
    data.store_id != null && String(data.store_id).trim() !== ""
      ? String(data.store_id)
      : "";

  if (!hasAmt && !val && !storeId) {
    return "";
  }

  let html = "";
  if (hasAmt) {
    html += `<div class="qrin-pay-summary-row"><span class="qrin-pay-summary-label">Nominal</span><span class="qrin-pay-summary-value">Rp ${nominal.toLocaleString("id-ID")}</span></div>`;
    if (adminRp > 0) {
      html += `<div class="qrin-pay-summary-row"><span class="qrin-pay-summary-label">Biaya admin</span><span class="qrin-pay-summary-value">Rp ${adminRp.toLocaleString("id-ID")}</span></div>`;
    }
    html += `<div class="qrin-pay-summary-row qrin-pay-summary-totalpay"><span class="qrin-pay-summary-label">Total pembayaran</span><span class="qrin-pay-summary-value">Rp ${totalRp.toLocaleString("id-ID")}</span></div>`;
  }
  if (val) {
    html += `<div class="qrin-pay-summary-row"><span class="qrin-pay-summary-label">Berlaku</span><span style="text-align:right;font-size:0.8rem;font-weight:600;max-width:58%">${escapeHtml(val)}</span></div>`;
  }
  if (storeId) {
    html += `<div class="qrin-pay-summary-row"><span class="qrin-pay-summary-label">Store ID</span><span style="font-size:0.8rem;">${escapeHtml(storeId)}</span></div>`;
  }
  return html;
}

function qrinCheckStatusElements() {
  const va = window._qrinActivePaymentModal === "qrinVaModal";
  return {
    msgEl: document.getElementById(va ? "qrinVaPaymentStatusMsg" : "qrinPaymentStatusMsg"),
    btn: document.getElementById(va ? "qrinVaCheckPaymentBtn" : "qrinCheckPaymentBtn"),
    resultBox: document.getElementById(va ? "qrinVaVoucherResult" : "qrinVoucherResult"),
    codeEl: document.getElementById(va ? "qrinVaVoucherCodeDisplay" : "qrinVoucherCodeDisplay"),
    copyBtn: document.getElementById(va ? "qrinVaCopyVoucherBtn" : "qrinCopyVoucherBtn"),
  };
}

function qrinInitCheckStatusUi(which) {
  const va = which === "va";
  const msg = document.getElementById(va ? "qrinVaPaymentStatusMsg" : "qrinPaymentStatusMsg");
  const btn = document.getElementById(va ? "qrinVaCheckPaymentBtn" : "qrinCheckPaymentBtn");
  const resultBox = document.getElementById(va ? "qrinVaVoucherResult" : "qrinVoucherResult");
  const codeEl = document.getElementById(va ? "qrinVaVoucherCodeDisplay" : "qrinVoucherCodeDisplay");
  if (btn) {
    btn.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Cek Pembayaran";
  }
  if (msg) {
    msg.style.display = "none";
    msg.textContent = "";
    msg.className = "qrin-status-msg";
  }
  if (resultBox) resultBox.style.display = "none";
  if (codeEl) codeEl.textContent = "";
}

/** Saluran QRIS di Qrin (bukan VA) — tanpa baris biaya admin di kartu */
function isQrinQrisMethodRow(m) {
  if (m == null) return false;
  const c = String(m.code || m.channel_code || "")
    .trim()
    .toLowerCase();
  if (c === "qr" || c === "qris") return true;
  const t = String(m.type || "").toUpperCase();
  if (t === "QRIS" || t === "QR") return true;
  const g = String(m.group || "").toUpperCase();
  return g.includes("QRIS");
}

// Variable untuk auto login timer
let autoLoginTimer = null;

// ==============================
// FUNGSI DETEKSI & CLEANUP ERROR
// ==============================

function checkAndCleanErrorOnLoad() {
  console.log("🔍 Checking for errors on page load...");
  
  // Cek apakah ada parameter error di URL (dari MikroTik)
  const urlParams = new URLSearchParams(window.location.search);
  const hasErrorParam = urlParams.has('error');
  
  // Cek apakah ada elemen notice error di halaman
  const errorNotice = document.querySelector(".notice");
  const hasErrorNotice = !!errorNotice;
  
  // Cek apakah ada teks error dari MikroTik
  let hasMikrotikErrorText = false;
  if (errorNotice) {
    const errorText = errorNotice.textContent.toLowerCase();
    const mikrotikErrorKeywords = [
      'already logged in',
      'invalid',
      'not enough',
      'voucher not found',
      'expired',
      'limit reached',
      'login failed'
    ];
    hasMikrotikErrorText = mikrotikErrorKeywords.some(keyword => errorText.includes(keyword));
  }
  
  // Jika ada indikasi error, CLEAR localStorage
  if (hasErrorParam || hasErrorNotice || hasMikrotikErrorText) {
    console.log("⚠️ Error detected on page load, clearing localStorage");
    console.log("Error details:", {
      hasErrorParam,
      hasErrorNotice,
      hasMikrotikErrorText
    });
    
    removeVoucherFromStorage();
    
    // Clean URL jika ada parameter error
    if (hasErrorParam) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    return true;
  }
  
  return false;
}

// ==============================
// FUNGSI QR SCANNER EXTERNAL
// ==============================

function openExternalQRScanner() {
  console.log("🔍 Opening External QR Scanner...");

  const callback = encodeURIComponent(window.location.href);

  const scannerUrl = `https://scan-qr.billinghub.id/?callback=${callback}`;

  window.open(scannerUrl, "_blank", "noopener,noreferrer");

  showAlert("📱 Membuka scanner QR code di tab baru...", "info");
}

// ==============================
// FUNGSI AUTO LOGIN DARI PARAMETER
// ==============================

function checkAutoLoginFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const voucherCode = urlParams.get("voucher");

  if (voucherCode && voucherCode.length >= 6) {
    console.log("🔍 Auto login detected from URL:", voucherCode);

    // Tampilkan pesan auto login
    document.getElementById("autoLoginMessage").style.display = "block";
    document.getElementById("kodeVoucher").value = voucherCode;

    // Start countdown
    let countdown = 3;
    const countdownElement = document.getElementById("autoLoginCountdown");
    countdownElement.textContent = countdown;

    autoLoginTimer = setInterval(() => {
      countdown--;
      countdownElement.textContent = countdown;

      if (countdown <= 0) {
        clearInterval(autoLoginTimer);
        submitVoucher();
      }
    }, 1000);

    // Hapus parameter dari URL agar tidak auto login berulang
    window.history.replaceState({}, document.title, window.location.pathname);

    return true;
  }
  return false;
}

// ==============================
// FUNGSI LOCALSTORAGE (Hanya untuk paket Silver ke atas)
// ==============================

function saveVoucherToStorage(voucherCode) {
  // Hanya simpan ke localStorage jika paket Silver ke atas (paket_id >= 2)
  // if (currentPackageId === null || currentPackageId < 2) {
  //   console.log("Paket Bronze/Free, skip menyimpan ke localStorage");
  //   return;
  // }

  try {
    const voucherData = {
      code: voucherCode,
      timestamp: Date.now(),
      companyToken: API_CONFIG.token,
      packageId: currentPackageId,
    };
    localStorage.setItem("wifi_voucher", JSON.stringify(voucherData));
    console.log("✅ Voucher saved to localStorage:", voucherCode);
  } catch (error) {
    console.error("Error saving to localStorage:", error);
  }
}

function removeVoucherFromStorage() {
  try {
    localStorage.removeItem("wifi_voucher");
    console.log("🗑️ Voucher removed from localStorage");
  } catch (error) {
    console.error("Error removing from localStorage:", error);
  }
}

function getSavedVoucher() {
  // Hanya cek localStorage jika paket Silver ke atas
  // if (currentPackageId === null || currentPackageId < 2) {
  //   console.log("Paket Bronze/Free, skip auto login");
  //   return null;
  // }

  try {
    const savedData = localStorage.getItem("wifi_voucher");
    if (!savedData) return null;

    const voucherData = JSON.parse(savedData);

    // Cek apakah token perusahaan sama
    if (voucherData.companyToken !== API_CONFIG.token) {
      removeVoucherFromStorage();
      return null;
    }

    // Cek apakah paket_id masih sama
    if (voucherData.packageId !== currentPackageId) {
      removeVoucherFromStorage();
      return null;
    }

    // Cek apakah voucher masih valid (30 hari)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    if (voucherData.timestamp < thirtyDaysAgo) {
      removeVoucherFromStorage();
      return null;
    }

    return voucherData.code;
  } catch (error) {
    console.error("Error reading localStorage:", error);
    return null;
  }
}

// ==============================
// FUNGSI AUTO LOGIN (Hanya untuk paket Silver ke atas)
// ==============================

async function checkVoucherStatus(voucherCode) {
  try {
    const response = await fetch(
      `${API_CONFIG.baseUrl}/v1/check-voucher/${API_CONFIG.token}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ voucher_code: voucherCode }),
      }
    );

    const result = await response.json();
    return result;
  } catch (error) {
    console.error("Error checking voucher:", error);
    return {
      success: false,
      message: "Tidak dapat terhubung ke server",
    };
  }
}

function showAutoLoginConfirm(voucherCode) {
  // Hanya tampilkan auto login jika paket Silver ke atas
  // if (currentPackageId === null || currentPackageId < 2) {
  //   console.log("Paket Bronze/Free, skip auto login confirm");
  //   return;
  // }

  console.log("🔍 Auto login detected:", voucherCode);

  document.getElementById("savedVoucherCode").textContent = voucherCode;

  const confirmBtn = document.getElementById("confirmAutoLoginBtn");
  confirmBtn.disabled = false;
  confirmBtn.innerHTML = "Ya, Lanjutkan Login";

  document.getElementById("voucherDetails").style.display = "none";
  document.getElementById("voucherDetails").innerHTML = "";

  savedVoucherForAutoLogin = voucherCode;

  openModal("autoLoginConfirmModal");
}

async function confirmAutoLogin() {
  const voucherCode = savedVoucherForAutoLogin;
  if (!voucherCode) {
    showAlert("Kode voucher tidak ditemukan", "danger");
    closeModal("autoLoginConfirmModal");
    return;
  }

  console.log("🔄 Processing auto login:", voucherCode);

  const confirmBtn = document.getElementById("confirmAutoLoginBtn");
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = "Memproses...";

  const result = await checkVoucherStatus(voucherCode);

  if (result.success) {
    console.log("✅ Voucher ready, auto logging in...");

    if (result.data.was_active && result.data.removed_count > 0) {
      document.getElementById("voucherDetails").style.display = "block";
      document.getElementById("voucherDetails").innerHTML = `
                <div style="color: var(--warning); font-size: 0.9rem;">
                    ⚠️ Menghapus ${result.data.removed_count} sesi aktif sebelumnya...
                </div>
            `;

      setTimeout(() => {
        proceedWithAutoLogin(voucherCode);
      }, 2000);
    } else {
      proceedWithAutoLogin(voucherCode);
    }
  } else {
    console.log("❌ Voucher not valid:", result.message);

    document.getElementById("voucherDetails").style.display = "block";
    document.getElementById("voucherDetails").innerHTML = `
            <div style="color: var(--danger);">
                <strong>❌ ${result.message}</strong>
            </div>
        `;

    confirmBtn.disabled = false;
    confirmBtn.innerHTML = "Ya, Lanjutkan Login";

    removeVoucherFromStorage();
  }
}

function proceedWithAutoLogin(voucherCode) {
  closeModal("autoLoginConfirmModal");

  document.getElementById("kodeVoucher").value = voucherCode;

  showAlert("✅ Voucher valid! Melakukan login...", "success");

  setTimeout(() => {
    submitVoucher();
  }, 1000);
}

function useNewVoucher() {
  removeVoucherFromStorage();
  document.getElementById("kodeVoucher").value = "";
  document.getElementById("kodeVoucher").focus();
  closeModal("autoLoginConfirmModal");
  showAlert("ℹ️ Silahkan masukkan kode voucher baru", "info");
}

// ==============================
// FUNGSI UTAMA - LOGIN VOUCHER
// ==============================

function submitVoucher() {
  // Hentikan timer auto login jika ada
  if (autoLoginTimer) {
    clearInterval(autoLoginTimer);
    autoLoginTimer = null;
  }

  // Sembunyikan pesan auto login
  document.getElementById("autoLoginMessage").style.display = "none";

  const voucherCode = document.getElementById("kodeVoucher").value.trim();
  const form = document.forms.loginvoucher;
  const submitBtn = document.getElementById("submitVoucherBtn");

  if (!voucherCode) {
    showAlert("Silahkan masukkan kode voucher", "warning");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Memproses...";

  try {
    form.username.value = voucherCode;

    const chapId = "$(chap-id)" || "";
    const chapChallenge = "$(chap-challenge)" || "";

    console.log("Login attempt:", voucherCode);

    if (typeof md5 === "function") {
      const hashString = chapId + voucherCode + chapChallenge;
      form.password.value = md5(hashString);
      console.log("MD5 hash generated");
    } else {
      console.warn("MD5 library not found, using plain text");
      form.password.value = voucherCode;
    }

    removeVoucherFromStorage();
    saveVoucherToStorage(voucherCode);

    showLoading(true);

    setTimeout(() => {
      console.log("Submitting form...");
      form.submit();
    }, 1000);
  } catch (error) {
    console.error("Login error:", error);
    showAlert("Terjadi kesalahan saat login: " + error.message, "danger");
    submitBtn.disabled = false;
    submitBtn.textContent = "Masuk";
    showLoading(false);
  }
}

// ==============================
// FUNGSI VALIDASI WHATSAPP (SIMPLE)
// ==============================

/** Mengubah string harga "Rp 10.000" menjadi angka 10000 */
function parseHargaToNumber(hargaStr) {
  if (typeof hargaStr === "number" && !isNaN(hargaStr)) return hargaStr;
  const num = parseInt(String(hargaStr || "").replace(/\D/g, ""), 10);
  return isNaN(num) ? 0 : num;
}

function validateWhatsAppNumber(whatsapp) {
  // Hilangkan semua karakter non-digit
  const cleanNumber = whatsapp.replace(/\D/g, "");

  if (!cleanNumber) {
    return {
      valid: false,
      message: "Nomor WhatsApp harus diisi",
    };
  }

  // Cek apakah dimulai dengan 62 atau 0
  if (!cleanNumber.startsWith("62") && !cleanNumber.startsWith("0")) {
    return {
      valid: false,
      message: "Nomor WhatsApp harus diawali dengan 62 atau 0",
    };
  }

  // Cek panjang
  if (cleanNumber.length < 10) {
    return {
      valid: false,
      message: "Nomor WhatsApp terlalu pendek",
    };
  }

  // Format untuk API: jika dimulai 0, ubah ke 62
  let apiFormat = cleanNumber;
  if (cleanNumber.startsWith("0")) {
    apiFormat = "62" + cleanNumber.substring(1);
  }

  return {
    valid: true,
    apiFormat: apiFormat,
  };
}

// ==============================
// FUNGSI ALERT DI MODAL
// ==============================

function showModalAlert(message, type = "info") {
  const modalAlertContainer = document.getElementById("modalAlertContainer");
  const alertClass = `modal-alert modal-alert-${type}`;

  const alertHtml = `
                <div class="${alertClass}">
                    <span style="font-size: 1.1rem;">
                        ${
                          type === "success"
                            ? "✅"
                            : type === "danger"
                            ? "❌"
                            : type === "warning"
                            ? "⚠️"
                            : "ℹ️"
                        }
                    </span>
                    <span>${message}</span>
                </div>
            `;

  modalAlertContainer.innerHTML = alertHtml;

  // Auto remove setelah 5 detik
  setTimeout(() => {
    if (modalAlertContainer.firstChild) {
      modalAlertContainer.firstChild.remove();
    }
  }, 5000);
}

function clearModalAlert() {
  const modalAlertContainer = document.getElementById("modalAlertContainer");
  modalAlertContainer.innerHTML = "";
}

// ==============================
// FUNGSI LAINNYA
// ==============================

async function loadCompanyInfo() {
  try {
    const response = await fetch(
      `${API_CONFIG.baseUrl}/v1/company/${API_CONFIG.token}`
    );
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();

    if (data.success && data.data) {
      companyData = data.data;
      currentPackageId = companyData.paket_id || 1;
      console.log("Company data loaded:", companyData);
      console.log("Current package ID:", currentPackageId);

      updateCompanyDisplay();
      updateAdminContactInfo();

      if (currentPackageId < 2) {
        showPackageInfo();
      }
    } else {
      console.warn("No company data found in response");
      currentPackageId = 1;
      updateCompanyDisplayFallback();
      updateAdminContactInfoFallback();
    }
  } catch (error) {
    console.error("Error loading company info:", error);
    currentPackageId = 1;
    updateCompanyDisplayFallback();
    updateAdminContactInfoFallback();
  }
}

function showPackageInfo() {
  const container = document.getElementById("packageInfoContainer");
  container.innerHTML = `
                <div class="package-info">
                    <div class="info-icon">ℹ️</div>
                    <div class="info-text">
                        Untuk pembelian voucher, silahkan hubungi admin melalui WhatsApp.
                    </div>
                </div>
            `;
}

function updateCompanyDisplay() {
  if (!companyData) return;

  const pageTitle = document.getElementById("pageTitle");
  const welcomeSection = document.getElementById("welcomeSection");

  // Update page title
  pageTitle.textContent = `📶 ${companyData.nama_perusahaan || "WiFi Login"}`;

  if (welcomeSection) {
    const companyNameElement = welcomeSection.querySelector(".company-name");
    const contactInfoElement = welcomeSection.querySelector(".contact-info");

    if (companyNameElement) {
      companyNameElement.textContent =
        companyData.nama_perusahaan || "WiFi Hotspot";
    }

    if (contactInfoElement) {
      contactInfoElement.textContent =
        "Voucher Internet • Auto Login • Aktivasi Otomatis";
    }
  }
}

function updateCompanyDisplayFallback() {
  const pageTitle = document.getElementById("pageTitle");
  const welcomeSection = document.getElementById("welcomeSection");

  pageTitle.textContent = "📶 WiFi Login";

  if (welcomeSection) {
    const companyNameElement = welcomeSection.querySelector(".company-name");
    const contactInfoElement = welcomeSection.querySelector(".contact-info");

    if (companyNameElement) {
      companyNameElement.textContent = "WiFi Hotspot";
    }

    if (contactInfoElement) {
      contactInfoElement.textContent =
        "Hubungi admin untuk pembelian voucher internet";
    }
  }
}

function updateAdminContactInfo() {
  const adminWhatsappElement = document.getElementById("adminWhatsapp");

  const whatsappSource = (companyData && (companyData.formatted_whatsapp || companyData.no_wa)) || null;
  if (whatsappSource) {
    let whatsappNumber = String(companyData.no_wa || companyData.formatted_whatsapp || "").replace(/\D/g, "");

    if (!whatsappNumber.startsWith("62")) {
      if (whatsappNumber.startsWith("0")) {
        whatsappNumber = "62" + whatsappNumber.substring(1);
      } else if (whatsappNumber.startsWith("8")) {
        whatsappNumber = "62" + whatsappNumber;
      }
    }

    let formattedNumber = whatsappNumber;
    if (formattedNumber.length === 12) {
      formattedNumber = formattedNumber.replace(
        /(\d{2})(\d{4})(\d{4})(\d{4})/,
        "$1 $2-$3-$4"
      );
    } else if (formattedNumber.length === 13) {
      formattedNumber = formattedNumber.replace(
        /(\d{2})(\d{4})(\d{4})(\d{5})/,
        "$1 $2-$3-$4"
      );
    } else if (formattedNumber.length === 14) {
      formattedNumber = formattedNumber.replace(
        /(\d{2})(\d{4})(\d{4})(\d{6})/,
        "$1 $2-$3-$4"
      );
    }

    adminWhatsappElement.textContent = formattedNumber || companyData.formatted_whatsapp || companyData.no_wa;
  } else {
    adminWhatsappElement.textContent = "6283874731480";
  }
}

function updateAdminContactInfoFallback() {
  const adminWhatsappElement = document.getElementById("adminWhatsapp");
  adminWhatsappElement.textContent = "6283874731480";
}

function copyToClipboard(elementId) {
  const element = document.getElementById(elementId);
  let text = element.textContent.trim();

  const cleanText = text.replace(/[^\d]/g, "");

  navigator.clipboard
    .writeText(cleanText)
    .then(() => {
      showAlert("Nomor berhasil disalin ke clipboard!", "success");
    })
    .catch((err) => {
      console.error("Failed to copy: ", err);
      const textArea = document.createElement("textarea");
      textArea.value = cleanText;
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand("copy");
        showAlert("Nomor berhasil disalin!", "success");
      } catch (err) {
        console.error("Fallback copy failed: ", err);
        showAlert("Gagal menyalin ke clipboard", "danger");
      }
      document.body.removeChild(textArea);
    });
}

async function loadVouchers() {
  showLoading(true);
  try {
    const response = await fetch(
      `${API_CONFIG.baseUrl}/v1/vouchers/${API_CONFIG.token}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("HTTP error loading vouchers:", response.status, errorText);

      if (response.status === 403) {
        console.log("Paket Bronze/Free - Tidak ada voucher list");

        const priceSection = document.getElementById("priceSection");
        if (priceSection) {
          priceSection.classList.add("hidden");
        }

        renderNoVouchers();
        return;
      }

      renderSimpleError("Tidak dapat memuat voucher");
      return;
    }

    const data = await response.json();
    console.log("Vouchers response:", data);

    if (data.success === true && data.data) {
      vouchers = data.data;
      if (data.data.length > 0) {
        settingData = {
          id: data.data[0].settingmikrotik_id,
          company_id: data.data[0].company_id,
        };
      }
      renderVouchers();
    } else if (data.success === false) {
      const errorMessage = data.message || "Tidak ada voucher tersedia";

      if (errorMessage.includes("paket Silver")) {
        const priceSection = document.getElementById("priceSection");
        if (priceSection) {
          priceSection.classList.add("hidden");
        }
      } else {
        renderSimpleError(errorMessage);
      }
    } else {
      renderNoVouchers();
    }
  } catch (error) {
    console.error("Error loading vouchers:", error);

    if (
      error.message.includes("Failed to fetch") ||
      error.message.includes("NetworkError")
    ) {
      renderSimpleError("Gagal terhubung ke server");
    } else {
      renderNoVouchers();
    }
  } finally {
    showLoading(false);
  }
}

function renderVouchers() {
  const voucherList = document.getElementById("voucherList");
  const priceSection = document.getElementById("priceSection");

  if (priceSection) {
    priceSection.classList.remove("hidden");
  }

  if (!vouchers || vouchers.length === 0) {
    renderNoVouchers();
    return;
  }

  voucherList.innerHTML = vouchers
    .map(
      (voucher) => `
        <div class="price-card" onclick="showBuyModal(${voucher.id})">
            <div class="price-left">
                <div class="price-icon">🎫</div>
                <div class="price-info">
                    <div class="price-title" title="${voucher.nama_voucher}">${voucher.nama_voucher}</div>
                    <div class="price-duration" title="${voucher.batas_waktu}">${voucher.batas_waktu}</div>
                </div>
            </div>
            <div class="price-right">
                ${voucher.harga}
                    <div style="font-size:0.8rem; margin-top:2px; opacity:0.9; color:orange;">
                        Klik untuk beli
                    </div>
            </div>
        </div>
    `
    )
    .join("");
}

function renderNoVouchers() {
  const voucherList = document.getElementById("voucherList");
  const priceSection = document.getElementById("priceSection");

  if (priceSection) {
    priceSection.classList.add("hidden");
  }

  voucherList.innerHTML = "";
}

function renderSimpleError(message) {
  const voucherList = document.getElementById("voucherList");
  const priceSection = document.getElementById("priceSection");

  if (priceSection) {
    priceSection.classList.remove("hidden");
  }

  voucherList.innerHTML = `
                <div class="simple-error">
                    ${message}
                </div>
            `;
}

function showBuyModal(voucherId) {
  if (currentPackageId < 2) {
    showAlert("Untuk pembelian voucher, hubungi admin", "warning");
    return;
  }

  selectedVoucher = vouchers.find((v) => v.id === voucherId);
  if (!selectedVoucher) {
    showAlert("Voucher tidak ditemukan", "danger");
    return;
  }

  clearModalAlert();

  document.getElementById("selectedVoucherInfo").innerHTML = `
        <p><strong>Paket:</strong> ${selectedVoucher.nama_voucher}</p>
        <p><strong>Harga:</strong> ${selectedVoucher.harga}</p>
        <p><strong>Durasi:</strong> ${selectedVoucher.batas_waktu}</p>
        <p><strong>Kuota:</strong> ${
          selectedVoucher.batas_data || "Unlimited"
        }</p>
    `;

  document.getElementById("customerName").value = "";
  document.getElementById("customerWhatsapp").value = "";

  const paymentMethodGroup = document.getElementById("paymentMethodGroup");
  const tripayMethodGrid = document.getElementById("tripayMethodGrid");
  const tripayMethodsLoading = document.getElementById("tripayMethodsLoading");
  const needPaymentMethod = companyData && companyData.need_payment_method === true;

  selectedPaymentMethodCode = null;

  if (needPaymentMethod) {
    paymentMethodGroup.style.display = "block";
    tripayMethodsLoading.style.display = "block";
    tripayMethodGrid.innerHTML = "";
    paymentMethodsList = [];
    const amount = parseHargaToNumber(selectedVoucher.harga);
    loadPaymentMethods(amount);
  } else {
    paymentMethodGroup.style.display = "none";
  }

  openModal("buyVoucherModal");
}

/** Ambil daftar metode pembayaran (Tripay / Qrin) dan render grid kartu */
async function loadPaymentMethods(amount) {
  const tripayMethodGrid = document.getElementById("tripayMethodGrid");
  const tripayMethodsLoading = document.getElementById("tripayMethodsLoading");

  if (!tripayMethodGrid || !tripayMethodsLoading) return;

  try {
    const url = `${API_CONFIG.baseUrl}/v1/vouchers/${API_CONFIG.token}/payment-methods?amount=${encodeURIComponent(amount)}`;
    const response = await fetch(url);
    const result = await response.json();

    tripayMethodsLoading.style.display = "none";

    if (!result.success) {
      paymentMethodsList = [];
      tripayMethodGrid.innerHTML = `<div class="tripay-method-empty">${escapeHtml(
        result.message || "Gagal memuat metode pembayaran"
      )}</div>`;
      return;
    }

    const methods = (result.data && result.data.methods) || [];
    if (methods.length === 0) {
      paymentMethodsList = [];
      tripayMethodGrid.innerHTML =
        '<div class="tripay-method-empty">Tidak ada metode pembayaran untuk nominal ini</div>';
      return;
    }

    paymentMethodsList = methods;

    const qrinUi = isQrinPaymentGateway();

    tripayMethodGrid.innerHTML = methods
      .map((m, idx) => {
        const name = m.name || m.label || m.group || m.code || "";
        const nameAttr = escapeHtml(name);
        const iconUrl = (m.icon_url || m.logo_url || "").trim();

        /* Tripay / gateway lain: tampilan kartu seperti semula (tanpa fee di kartu) */
        if (!qrinUi) {
          return `
            <div class="tripay-method-card" data-idx="${idx}" onclick="selectPaymentMethodCard(this)">
              <div class="tripay-method-frame">
                ${
                  iconUrl
                    ? `<img src="${escapeAttr(iconUrl)}" alt="${nameAttr}" class="tripay-method-icon" onerror="this.style.display='none'">`
                    : `<span class="tripay-method-placeholder">💳</span>`
                }
              </div>
              <div class="tripay-method-name" title="${nameAttr}">${name}</div>
            </div>
          `;
        }

        /* Qrin: QRIS = +750 lalu 0,7% dari (nominal+750); VA/gerai = +Rp saja (tanpa kata "Admin") */
        const fee = methodFeeAmount(m);
        const inactive = m.active === false;
        const isQr = isQrinQrisMethodRow(m);
        let feeLine = "";
        if (isQr) {
          feeLine = `<div class="tripay-method-fee tripay-method-fee--qris">+750 lalu 0,7%</div>`;
        } else if (fee > 0) {
          feeLine = `<div class="tripay-method-fee">+Rp ${fee.toLocaleString("id-ID")}</div>`;
        }

        const cardClass =
          "tripay-method-card" + (inactive ? " tripay-method-card--inactive" : "");

        return `
            <div class="${cardClass}" data-idx="${idx}" onclick="selectPaymentMethodCard(this)">
              <div class="tripay-method-frame">
                ${
                  iconUrl
                    ? `<img src="${escapeAttr(iconUrl)}" alt="${nameAttr}" class="tripay-method-icon" onerror="this.style.display='none'">`
                    : `<span class="tripay-method-placeholder">💳</span>`
                }
              </div>
              <div class="tripay-method-name" title="${nameAttr}">${name}</div>
              ${feeLine}
            </div>
          `;
      })
      .join("");
  } catch (err) {
    console.error("Error loading payment methods:", err);
    tripayMethodsLoading.style.display = "none";
    tripayMethodGrid.innerHTML =
      '<div class="tripay-method-empty">Gagal memuat metode pembayaran</div>';
  }
}

/** Pilih kartu metode bayar (Tripay / Qrin) */
function selectPaymentMethodCard(el) {
  const idx = parseInt(el.dataset.idx, 10);
  const m = paymentMethodsList[idx];
  if (!m) return;
  if (isQrinPaymentGateway() && m.active === false) {
    showModalAlert(
      "Metode ini tidak tersedia untuk nominal voucher (VA biasanya minimal Rp 10.000).",
      "warning"
    );
    return;
  }
  const code = m.code || m.channel_code || String(m.id ?? "");
  selectedPaymentMethodCode = code;
  document.querySelectorAll(".tripay-method-card").forEach((node) => {
    node.classList.toggle("selected", node === el);
  });
}

async function processPurchase(event) {
  event.preventDefault();

  if (currentPackageId < 2) {
    showAlert("Untuk pembelian voucher, hubungi admin", "warning");
    return false;
  }

  const name = document.getElementById("customerName").value.trim();
  const whatsapp = document.getElementById("customerWhatsapp").value.trim();

  clearModalAlert();

  // Validasi nama
  if (!name || name.length < 5 || name.length > 100) {
    showModalAlert(
      "Nama harus diisi (minimal 5 karakter, maksimal 100 karakter)",
      "warning"
    );
    return false;
  }

  // Validasi WhatsApp
  const validationResult = validateWhatsAppNumber(whatsapp);
  if (!validationResult.valid) {
    showModalAlert(validationResult.message, "warning");
    return false;
  }

  const needPaymentMethod = companyData && companyData.need_payment_method === true;
  const selectedMethodCode = selectedPaymentMethodCode || "";

  if (needPaymentMethod && (!selectedMethodCode || selectedMethodCode === "")) {
    showModalAlert("Pilih metode pembayaran terlebih dahulu", "warning");
    return false;
  }

  if (!selectedVoucher || !settingData) {
    showModalAlert("Data voucher tidak valid", "danger");
    return false;
  }

  const submitBtn = document.getElementById("submitOrderBtn");
  submitBtn.disabled = true;
  submitBtn.innerHTML = "Memproses...";

  try {
    const orderData = {
      voucher_id: selectedVoucher.id,
      wa_number: validationResult.apiFormat,
      nama_pembeli: name,
      settingmikrotik_id: settingData.id,
      company_id: settingData.company_id,
    };

    if (needPaymentMethod && selectedMethodCode) {
      const method = paymentMethodsList.find(
        (m) => String(m.code || m.channel_code || "") === String(selectedMethodCode)
      );
      const fee = method ? methodFeeAmount(method) : 0;
      const qrinQr = method && isQrinQrisMethodRow(method);
      if (isQrinPaymentGateway()) {
        orderData.qrin_payment_method = selectedMethodCode;
        /* Biaya admin di payload hanya untuk VA; QRIS tidak kirim +750 / % */
        if (fee > 0 && !qrinQr) orderData.payment_fee = fee;
      } else {
        orderData.payment_method = selectedMethodCode;
        if (fee > 0) orderData.payment_fee = fee;
      }
    }

    console.log("Sending order data:", orderData);

    const response = await fetch(
      `${API_CONFIG.baseUrl}/v1/vouchers/${API_CONFIG.token}/order`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderData),
      }
    );

    const result = await response.json();
    if (result.success) {
      const data = result.data || {};
      if (isQrinPaymentGateway() && data.amount != null) {
        setQrinOrderFeeSummaryFromPurchase(data);
      } else {
        window._qrinOrderFeeSummary = null;
      }

      document.getElementById("successMessage").textContent =
        "Order berhasil dibuat! Membuka metode pembayaran...";
      closeModal("buyVoucherModal");
      openModal("successModal");

      if (data.midtrans_token) {
        setTimeout(() => {
          openSnapPayment(data.midtrans_token);
        }, 1000);
      } else if (data.payment_url) {
        setTimeout(() => {
          openTripayPayment(data.payment_url, data.kode_transaksi);
        }, 1000);
      } else if (
        isQrinPaymentGateway() &&
        (data.payment_kind === "VA" ||
          (Array.isArray(data.va_number_list) && data.va_number_list.length) ||
          (data.va_number && String(data.va_number).trim() !== ""))
      ) {
        setTimeout(() => {
          showQrinVaModal(data);
        }, 1000);
      } else if (isQrinPaymentGateway() && data.qr_content) {
        setTimeout(() => {
          showQrinPaymentModal(data);
        }, 1000);
      } else {
        closeModal("successModal");
        showAlert(result.message || "Order berhasil dibuat", "success");
      }
    } else {
      showModalAlert(result.message || "Gagal membuat order", "danger");
    }
  } catch (error) {
    console.error("Purchase error:", error);
    showModalAlert("Terjadi kesalahan saat memproses pembelian", "danger");
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = "Beli Sekarang";
  }
  return false;
}

/** Redirect ke halaman pembayaran Tripay (checkout) */
function openTripayPayment(paymentUrl, kodeTransaksi) {
  closeModal("successModal");
  if (paymentUrl) {
    window.open(paymentUrl, "_blank", "noopener,noreferrer");
    showAlert(
      "✅ Halaman pembayaran Tripay dibuka. Selesaikan pembayaran di tab baru. Voucher akan dikirim ke WhatsApp setelah pembayaran berhasil.",
      "success"
    );
  } else {
    showAlert("URL pembayaran tidak valid", "danger");
  }
}

function copyQrinVaText(text) {
  const t = String(text || "");
  if (!t) return;
  const done = () => showAlert("Disalin ke clipboard", "success");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done).catch(() => {
      fallbackCopyQrinVa(t);
    });
  } else {
    fallbackCopyQrinVa(t);
  }
}

function fallbackCopyQrinVa(t) {
  const ta = document.createElement("textarea");
  ta.value = t;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    showAlert("Disalin", "success");
  } catch (e) {
    showAlert("Gagal menyalin", "danger");
  }
  document.body.removeChild(ta);
}

/** Instruksi Virtual Account / gerai (Qrin) */
function showQrinVaModal(data) {
  closeModal("successModal");

  window._qrinOrderKode = data.kode_transaksi || null;
  window._qrinActivePaymentModal = "qrinVaModal";
  window._qrinVoucherCode = null;
  qrinInitCheckStatusUi("va");

  let rows = [];
  if (Array.isArray(data.va_number_list) && data.va_number_list.length) {
    rows = data.va_number_list.filter((r) => (r.va_number || "").toString().trim() !== "");
  }
  if (rows.length === 0 && data.va_number && String(data.va_number).trim() !== "") {
    rows = [{ bank: data.va_bank || "Bank", va_number: data.va_number }];
  }

  const meta = String((data.va_bank || "") + " " + (data.reference || "")).toLowerCase();
  const isGerai = meta.includes("finpaycode") || meta.includes("indomaret");
  const titleEl = document.getElementById("qrinVaModalTitle");
  if (titleEl) {
    titleEl.textContent = isGerai ? "Bayar di Gerai" : "Virtual Account";
  }

  const summaryEl = document.getElementById("qrinVaSummary");
  if (summaryEl) {
    const html = buildQrinOrderSummaryHtml(data);
    summaryEl.innerHTML =
      html ||
      '<p class="tripay-methods-hint" style="margin:0;">Lakukan pembayaran sesuai nominal di bawah.</p>';
    summaryEl.style.display = "block";
  }

  const body = document.getElementById("qrinVaModalBody");
  if (!body) return;

  if (rows.length === 0) {
    body.innerHTML =
      '<div class="tripay-method-empty">Nomor pembayaran tidak tersedia. Hubungi admin jika masalah berlanjut.</div>';
    openModal("qrinVaModal");
    return;
  }

  const copyLabel = isGerai ? "Salin kode bayar" : "Salin nomor VA";

  body.innerHTML = rows
    .map((row) => {
      const bank = row.bank || data.va_bank || "Virtual Account";
      const num = String(row.va_number || "").trim();
      return `<div class="qrin-va-card">
          <div class="qrin-va-bank">${escapeHtml(bank)}</div>
          <div class="qrin-va-num">${escapeHtml(num)}</div>
          <button type="button" class="qrin-va-copy" onclick="copyQrinVaText(${JSON.stringify(num)})">${copyLabel}</button>
        </div>`;
    })
    .join("");

  openModal("qrinVaModal");
}

/** Modal QRIS (Qrin) — qr_content dari response */
function showQrinPaymentModal(data) {
  closeModal("successModal");

  const qrContent = data.qr_content;
  if (!qrContent) {
    showAlert("Data QR tidak tersedia", "danger");
    return;
  }

  window._qrinOrderKode = data.kode_transaksi || null;
  window._qrinActivePaymentModal = "qrinPaymentModal";
  window._qrinVoucherCode = null;
  qrinInitCheckStatusUi("qr");

  const summaryEl = document.getElementById("qrinQrSummary");
  if (summaryEl) {
    const html = buildQrinOrderSummaryHtml(data);
    if (html) {
      summaryEl.innerHTML = html;
      summaryEl.style.display = "block";
    } else {
      summaryEl.innerHTML = "";
      summaryEl.style.display = "none";
    }
  }

  const canvas = document.getElementById("qrinQrCanvas");

  canvas.width = 0;
  canvas.height = 0;

  if (typeof QRCode !== "undefined" && QRCode.toCanvas) {
    QRCode.toCanvas(canvas, qrContent, { width: 200, margin: 2 }, (err) => {
      if (err) {
        console.error("QRCode error:", err);
        showAlert("Gagal menampilkan QR. Silakan coba lagi.", "danger");
      }
    });
  } else {
    showAlert("Library QR tidak tersedia. Silakan refresh halaman.", "danger");
  }

  openModal("qrinPaymentModal");
}

let qrinCheckPaymentBusy = false;

/** Cek status pembayaran order Qrin (API publik, sama logika dengan halaman voucher web) */
async function qrinCheckPaymentStatus() {
  const kode = window._qrinOrderKode;
  const { msgEl, btn, resultBox, codeEl, copyBtn } = qrinCheckStatusElements();

  if (!kode || qrinCheckPaymentBusy) return;

  qrinCheckPaymentBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Memeriksa...";
  }
  if (msgEl) {
    msgEl.style.display = "block";
    msgEl.className = "qrin-status-msg qrin-status-msg--info";
    msgEl.textContent = "Memeriksa status pembayaran...";
  }
  if (resultBox) resultBox.style.display = "none";

  try {
    const url = `${API_CONFIG.baseUrl}/v1/vouchers/${API_CONFIG.token}/cek-order-qrin`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ kode_transaksi: kode }),
      mode: "cors",
      credentials: "omit",
    });

    const raw = await response.text();
    let result;
    try {
      result = raw ? JSON.parse(raw) : {};
    } catch (parseErr) {
      console.error("cek-order-qrin: bukan JSON", response.status, raw.slice(0, 400));
      if (msgEl) {
        msgEl.style.display = "block";
        msgEl.className = "qrin-status-msg qrin-status-msg--warn";
        msgEl.textContent =
          "Server mengembalikan respons tidak valid (HTTP " +
          response.status +
          "). Pastikan alamat API benar atau coba lagi.";
      }
      return;
    }

    if (!result.success) {
      if (msgEl) {
        msgEl.style.display = "block";
        msgEl.className = "qrin-status-msg qrin-status-msg--warn";
        msgEl.textContent =
          result.message || "Gagal memeriksa status pembayaran.";
      }
      return;
    }

    const d = result.data;
    if (d == null || typeof d !== "object") {
      if (msgEl) {
        msgEl.style.display = "block";
        msgEl.className = "qrin-status-msg qrin-status-msg--warn";
        msgEl.textContent = "Format respons tidak dikenal. Coba lagi.";
      }
      return;
    }

    if (d.paid && d.processing) {
      if (msgEl) {
        msgEl.style.display = "block";
        msgEl.className = "qrin-status-msg qrin-status-msg--info";
        msgEl.textContent =
          result.message ||
          "Pembayaran diterima. Voucher sedang dibuat — coba lagi dalam beberapa detik.";
      }
      return;
    }

    if (d.paid && d.username_voucher) {
      window._qrinVoucherCode = d.username_voucher;
      if (msgEl) msgEl.style.display = "none";
      if (codeEl) codeEl.textContent = d.username_voucher;
      if (resultBox) resultBox.style.display = "block";
      if (copyBtn) {
        copyBtn.onclick = function () {
          copyQrinVaText(d.username_voucher);
        };
      }
      if (btn) btn.style.display = "none";
      showAlert("Pembayaran berhasil. Simpan kode voucher Anda.", "success");
      return;
    }

    if (msgEl) {
      msgEl.style.display = "block";
      msgEl.className = "qrin-status-msg qrin-status-msg--pending";
      msgEl.textContent =
        result.message ||
        "Pembayaran belum terkonfirmasi. Setelah membayar, tunggu beberapa detik lalu cek lagi.";
    }
  } catch (e) {
    console.error("qrinCheckPaymentStatus:", e);
    if (msgEl) {
      msgEl.style.display = "block";
      msgEl.className = "qrin-status-msg qrin-status-msg--warn";
      const isNet =
        e &&
        String(e.message || "")
          .toLowerCase()
          .includes("failed to fetch");
      msgEl.textContent = isNet
        ? "Tidak terhubung ke server (jaringan diblokir / halaman dibuka dari file:// / CORS). Gunakan hotspot dengan internet atau hubungi admin."
        : (e && e.message) || "Terjadi kesalahan. Coba lagi.";
    }
  } finally {
    qrinCheckPaymentBusy = false;
    const fe = qrinCheckStatusElements();
    if (fe.btn && fe.btn.style.display !== "none") {
      fe.btn.disabled = false;
      fe.btn.textContent = "Cek Pembayaran";
    }
  }
}

function openSnapPayment(token) {
  window.snap.pay(token, {
    onSuccess: function (result) {
      console.log("Payment success:", result);
      showAlert(
        "✅ Pembayaran berhasil! Voucher akan dikirim ke WhatsApp Anda.",
        "success"
      );
      setTimeout(() => closeModal("successModal"), 3000);
    },
    onPending: function (result) {
      console.log("Payment pending:", result);
      showAlert(
        "⏳ Menunggu pembayaran. Silakan selesaikan pembayaran Anda.",
        "warning"
      );
      closeModal("successModal");
    },
    onError: function (result) {
      console.log("Payment error:", result);
      showAlert("❌ Pembayaran gagal. Silakan coba lagi.", "danger");
      closeModal("successModal");
    },
    onClose: function () {
      console.log("Payment modal closed by user");
      showAlert(
        "ℹ️ Anda dapat melakukan pembayaran ulang dengan mengisi form lagi.",
        "info"
      );
      closeModal("successModal");
    },
  });
}

function showLoading(show) {
  document.getElementById("loadingSpinner").classList.toggle("active", show);
}

function showAlert(message, type = "info") {
  const alertContainer = document.getElementById("alertContainer");
  const alertClass = `alert alert-${type}`;

  const alertHtml = `
        <div class="${alertClass}">
            <span>${message}</span>
            <button onclick="this.parentElement.remove()">×</button>
        </div>
    `;

  alertContainer.innerHTML = alertHtml;
  setTimeout(() => {
    if (alertContainer.firstChild) {
      alertContainer.firstChild.remove();
    }
  }, 5000);
}

function toggleTheme() {
  const body = document.body;
  const btn = document.querySelector(".theme-toggle");
  body.classList.toggle("dark");
  btn.textContent = body.classList.contains("dark") ? "☀️" : "🌙";
  localStorage.setItem(
    "theme",
    body.classList.contains("dark") ? "dark" : "light"
  );

  const themeColor = body.classList.contains("dark") ? "#121212" : "#13737D";
  document
    .querySelector('meta[name="theme-color"]')
    .setAttribute("content", themeColor);
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove("active");
  document.body.style.overflow = "";

  if (modalId === "buyVoucherModal") {
    clearModalAlert();
  }
}

function closeModalOnBackdrop(event, modalId) {
  if (event.target.classList.contains("modal")) {
    closeModal(modalId);
  }
}

// ==============================
// INITIALIZATION
// ==============================
document.addEventListener("DOMContentLoaded", () => {
  console.log("🚀 WiFi Login Page Initialized");

  // Load saved theme
  if (localStorage.getItem("theme") === "dark") {
    document.body.classList.add("dark");
    document.querySelector(".theme-toggle").textContent = "☀️";
    document
      .querySelector('meta[name="theme-color"]')
      .setAttribute("content", "#121212");
  }

  // CEK DAN CLEAN ERROR SAAT HALAMAN LOAD
  // Ini penting: hapus voucher dari localStorage jika ada error
  const hasError = checkAndCleanErrorOnLoad();

  // Cek auto login dari URL parameter (hasil scan)
  checkAutoLoginFromUrl();

  // Load company info dan vouchers
  loadCompanyInfo();
  loadVouchers();

  // AUTO LOGIN: Cek apakah ada voucher tersimpan (hanya untuk paket Silver ke atas)
  // TAPI SKIP jika ada error
  setTimeout(() => {
    if (hasError) {
      console.log("ℹ️ Skipping auto login because error was detected on load");
      return;
    }
    
    const savedVoucher = getSavedVoucher();
    if (savedVoucher) {
      console.log("🔍 Auto login detected. Saved voucher:", savedVoucher);
      showAutoLoginConfirm(savedVoucher);
    } else {
      console.log("ℹ️ No saved voucher found for auto login");
    }
  }, 1500);

  // Auto refresh vouchers setiap 5 menit
  setInterval(loadVouchers, 5 * 60 * 1000);

  // Enter key untuk submit voucher
  document
    .getElementById("kodeVoucher")
    .addEventListener("keypress", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submitVoucher();
      }
    });

  // Fix untuk horizontal scroll di mobile
  const voucherContainer = document.querySelector(".voucher-scroll-container");
  if (voucherContainer) {
    voucherContainer.addEventListener(
      "touchstart",
      function (e) {
        this.style.overflowX = "scroll";
        this.style.overflowY = "hidden";
      },
      { passive: true }
    );

    voucherContainer.addEventListener(
      "touchmove",
      function (e) {
        e.stopPropagation();
      },
      { passive: true }
    );
  }

  // Mencegah zoom double tap di mobile
  let lastTouchEnd = 0;
  document.addEventListener(
    "touchend",
    function (event) {
      const now = new Date().getTime();
      if (now - lastTouchEnd <= 300) {
        event.preventDefault();
      }
      lastTouchEnd = now;
    },
    false
  );
});

document.addEventListener("gesturestart", function (e) {
  e.preventDefault();
});

document.addEventListener(
  "touchmove",
  function (event) {
    if (event.touches.length > 1) {
      event.preventDefault();
    }
  },
  { passive: false }
);

document.addEventListener("DOMContentLoaded", function () {
  document.documentElement.style.scrollBehavior = "smooth";
  document.body.style.overflowY = "auto";
  document.body.style.webkitOverflowScrolling = "touch";
});