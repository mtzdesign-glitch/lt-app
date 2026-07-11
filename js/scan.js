/* LT — QR scanning (Chrome on Android has BarcodeDetector).
   Shared by the builder (capturing a tag value into the equipment library)
   and Gate 0 (verifying a physical tag against the KC's equipment manifest). */

export function qrSupported() {
  return 'BarcodeDetector' in window;
}

export function scanQR() {
  return new Promise(async (resolve) => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch {
      resolve(null);
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'capture-overlay';
    overlay.innerHTML = `
      <video id="scan-video" autoplay playsinline muted></video>
      <div class="rec-timer">Point the camera at the QR code</div>
      <div class="rec-controls"><button class="btn btn-secondary" id="scan-cancel">CANCEL</button></div>
    `;
    document.body.appendChild(overlay);
    const v = overlay.querySelector('#scan-video');
    v.srcObject = stream;

    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    let live = true;
    function cleanup(value) {
      live = false;
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      resolve(value);
    }
    overlay.querySelector('#scan-cancel').onclick = () => cleanup(null);

    const poll = setInterval(async () => {
      if (!live) { clearInterval(poll); return; }
      try {
        const codes = await detector.detect(v);
        if (codes.length) { clearInterval(poll); cleanup(codes[0].rawValue); }
      } catch { /* frame not ready yet */ }
    }, 400);
  });
}
