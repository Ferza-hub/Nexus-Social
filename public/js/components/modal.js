// Modal component

const Modal = (() => {
  const overlay = document.getElementById('modal-overlay');
  const box     = document.getElementById('modal-box');
  const title   = document.getElementById('modal-title');
  const body    = document.getElementById('modal-body');
  const closeBtn = document.getElementById('modal-close');

  function open(t, html, { wide = false } = {}) {
    title.textContent = t;
    body.innerHTML = html;
    box.style.width = wide ? '680px' : '480px';
    overlay.classList.remove('hidden');
  }

  function close() {
    overlay.classList.add('hidden');
    body.innerHTML = '';
  }

  function confirm(message, onConfirm) {
    open('Confirm', `
      <p style="margin-bottom:20px;">${message}</p>
      <div class="flex gap-1" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-danger" id="confirm-ok-btn">Confirm</button>
      </div>
    `);
    document.getElementById('confirm-ok-btn').onclick = () => {
      close();
      onConfirm();
    };
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  return { open, close, confirm };
})();
