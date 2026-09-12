import { PET_SPECIES, SPECIES_LABELS, PET_FILE_LIMIT, defaultAppearance, validateAppearance, petMarkup, exportPet, parsePetFile } from '/shared/pet.mjs';

const COLORS = ['#FFFAE9', '#EEE1BC', '#66594D', '#354B3F', '#F2A79D', '#D87068', '#719659', '#ACCA7D', '#E0A365', '#A2B9CE', '#D5E3E9', '#7E96B1'];
let activeEditor;
function bitmap(appearance, scale = 1) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16 * scale;
  const ctx = canvas.getContext('2d');
  appearance.pixels.forEach((color, i) => { if (color) { ctx.fillStyle = color; ctx.fillRect((i % 16) * scale, Math.floor(i / 16) * scale, scale, scale); } });
  return canvas;
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function openPetEditor(pet, { onSave } = {}) {
  if (activeEditor) { activeEditor.focus(); return; }
  let draft = { name: pet.name, species: PET_SPECIES.includes(pet.species) ? pet.species : 'xiaotangyuan', appearance: validateAppearance(pet.appearance ?? defaultAppearance(pet.species)) };
  let brush = '#FFFAE9', history = [], drawing = false, lastCell = -1, cursor = 0, busy = false;
  const previousFocus = document.activeElement, controller = new AbortController(), signal = controller.signal;
  const dialog = document.createElement('dialog'); activeEditor = dialog;
  dialog.id = 'pet-editor'; dialog.className = 'pet-editor'; dialog.setAttribute('aria-labelledby', 'pet-editor-title');
  dialog.innerHTML = `<div class="pe-header"><div><span class="eyebrow">PIXEL COMPANION</span><h2 id="pet-editor-title">给搭档换个模样</h2><p>16 × 16 像素，每一格都是你的创作。</p></div><button type="button" data-pe="close" aria-label="关闭外观编辑器">×</button></div>
    <div class="pe-body"><div class="pe-drawing"><canvas class="pe-canvas" width="320" height="320" tabindex="0" aria-label="像素画板：方向键移动，空格绘制。也可点击或拖动绘制。"></canvas><p class="pe-help">点击或拖动绘制 · 右键擦除<br>键盘：方向键选格，空格上色</p><div class="pe-tools"><button type="button" data-pe="paint" aria-pressed="true">画笔</button><button type="button" data-pe="erase" aria-pressed="false">橡皮</button><button type="button" data-pe="undo" disabled>撤销</button><button type="button" data-pe="reset">恢复预设</button></div></div>
    <div class="pe-settings"><div class="pe-preview" aria-label="宠物外观预览"></div><label for="pe-name">搭档的名字</label><input id="pe-name" maxlength="32" autocomplete="off"><label for="pe-species">选择像素预设</label><select id="pe-species">${PET_SPECIES.map(s => `<option value="${s}">${SPECIES_LABELS[s]}</option>`).join('')}</select><p class="pe-help">切换预设会替换画布，可撤销。</p><label>画笔颜色</label><div class="pe-palette">${COLORS.map(c => `<button type="button" data-color="${c}" aria-label="颜色 ${c}" title="${c}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="${c}"/></svg></button>`).join('')}</div><label class="pe-color-label" for="pe-color">自选颜色<input id="pe-color" type="color" value="#fffae9"></label>
    <div class="pe-files"><button type="button" data-pe="import">导入 JSON / PNG</button><input data-pe="file" type="file" accept=".json,.png,application/json,image/png" hidden><div><button type="button" data-pe="json">导出宠物 JSON</button><button type="button" data-pe="png">导出像素 PNG</button></div><p class="pe-help">JSON 保存名字与外观；PNG 保存透明像素图。<br>导入 PNG 须为 16–256 px 的正方形。</p></div></div></div>
    <div class="pe-footer"><p class="pe-message" role="status" aria-live="polite">外观文件只包含名字和像素，不包含账号、积分或密钥。</p><button type="button" class="primary" data-pe="save">保存搭档外观</button></div>`;
  document.body.append(dialog);
  const q = s => dialog.querySelector(s), canvas = q('canvas'), ctx = canvas.getContext('2d');
  const listen = (target, type, handler, opts = {}) => target.addEventListener(type, handler, { ...opts, signal });
  const message = (text, error = false) => { q('.pe-message').textContent = text; q('.pe-message').classList.toggle('pe-error', error); };
  function snapshot() { history.push(structuredClone(draft)); if (history.length > 64) history.shift(); }
  function fields() { q('#pe-name').value = draft.name; q('#pe-species').value = draft.species; }
  function draw() {
    ctx.clearRect(0, 0, 320, 320);
    draft.appearance.pixels.forEach((color, i) => { const x = i % 16, y = Math.floor(i / 16); ctx.fillStyle = color || ((x + y) % 2 ? '#E8EADC' : '#F5F4EC'); ctx.fillRect(x * 20, y * 20, 20, 20); });
    ctx.strokeStyle = '#54634225'; ctx.lineWidth = 1;
    for (let n = 0; n <= 16; n++) { ctx.beginPath(); ctx.moveTo(n * 20, 0); ctx.lineTo(n * 20, 320); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, n * 20); ctx.lineTo(320, n * 20); ctx.stroke(); }
    if (document.activeElement === canvas) { ctx.strokeStyle = '#284936'; ctx.lineWidth = 2; ctx.strokeRect(cursor % 16 * 20 + 1, Math.floor(cursor / 16) * 20 + 1, 18, 18); }
    q('.pe-preview').innerHTML = petMarkup(draft, 'pe-preview-pet'); q('[data-pe="undo"]').disabled = busy || !history.length;
    q('[data-pe="paint"]').setAttribute('aria-pressed', String(brush !== null)); q('[data-pe="erase"]').setAttribute('aria-pressed', String(brush === null));
    dialog.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === brush)));
  }
  function close() { if (busy) return; dialog.close(); }
  listen(dialog, 'close', () => { controller.abort(); dialog.remove(); activeEditor = null; previousFocus?.focus(); });
  listen(dialog, 'cancel', e => { e.preventDefault(); close(); });
  listen(q('[data-pe="close"]'), 'click', close);
  listen(q('#pe-name'), 'input', () => { draft.name = q('#pe-name').value; });
  listen(q('#pe-species'), 'change', () => { snapshot(); draft.species = q('#pe-species').value; draft.appearance = defaultAppearance(draft.species); draw(); });
  listen(q('[data-pe="reset"]'), 'click', () => { snapshot(); draft.appearance = defaultAppearance(draft.species); draw(); });
  listen(q('[data-pe="undo"]'), 'click', () => { if (history.length) { draft = history.pop(); fields(); draw(); } });
  listen(q('[data-pe="paint"]'), 'click', () => { brush = q('#pe-color').value.toUpperCase(); draw(); });
  listen(q('[data-pe="erase"]'), 'click', () => { brush = null; draw(); });
  listen(q('#pe-color'), 'input', () => { brush = q('#pe-color').value.toUpperCase(); draw(); });
  dialog.querySelectorAll('[data-color]').forEach(b => listen(b, 'click', () => { brush = b.dataset.color; q('#pe-color').value = brush; draw(); }));
  function paint(e) {
    const rect = canvas.getBoundingClientRect(), x = Math.floor((e.clientX - rect.left) / rect.width * 16), y = Math.floor((e.clientY - rect.top) / rect.height * 16);
    if (x < 0 || y < 0 || x >= 16 || y >= 16) return;
    const cell = y * 16 + x; if (cell === lastCell) return; lastCell = cursor = cell;
    draft.appearance.pixels[cell] = e.buttons === 2 ? null : brush; draw();
  }
  listen(canvas, 'contextmenu', e => e.preventDefault());
  listen(canvas, 'pointerdown', e => { if (busy || ![0, 2].includes(e.button)) return; e.preventDefault(); canvas.focus(); canvas.setPointerCapture(e.pointerId); snapshot(); drawing = true; lastCell = -1; paint(e); });
  listen(canvas, 'pointermove', e => { if (drawing) paint(e); });
  listen(canvas, 'pointerup', () => { drawing = false; lastCell = -1; });
  listen(canvas, 'pointercancel', () => { drawing = false; lastCell = -1; });
  listen(canvas, 'focus', draw); listen(canvas, 'blur', draw);
  // Stop page-level game shortcuts while a cosmetic dialog is open.
  listen(document, 'keydown', e => {
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.target !== canvas || busy) return;
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (Object.hasOwn(directions, e.key)) { e.preventDefault(); const [dx, dy] = directions[e.key]; cursor = Math.min(15, Math.max(0, Math.floor(cursor / 16) + dy)) * 16 + Math.min(15, Math.max(0, cursor % 16 + dx)); draw(); }
    if (e.key === ' ') { e.preventDefault(); snapshot(); draft.appearance.pixels[cursor] = brush; draw(); }
  }, { capture: true });
  listen(q('[data-pe="json"]'), 'click', () => { try { const data = exportPet(draft); download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'petrival-pet.json'); message('已导出宠物外观 JSON。'); } catch (e) { message(e.message, true); } });
  listen(q('[data-pe="png"]'), 'click', () => bitmap(draft.appearance).toBlob(blob => { if (blob) { download(blob, 'petrival-pet-16x16.png'); message('已导出 16 × 16 透明背景 PNG。'); } }, 'image/png'));
  listen(q('[data-pe="import"]'), 'click', () => q('[data-pe="file"]').click());
  listen(q('[data-pe="file"]'), 'change', async e => {
    const file = e.target.files?.[0]; e.target.value = ''; if (!file || busy) return;
    busy = true; drawing = false; dialog.querySelectorAll('button,input,select').forEach(element => element.disabled = true); message('正在读取外观文件…');
    try {
      let imported;
      if (/\.png$/i.test(file.name)) {
        if (file.size > 1024 * 1024) throw new Error('PNG 不能超过 1 MB');
        const bytes = await file.arrayBuffer(), view = new DataView(bytes);
        if (bytes.byteLength < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('不是有效的 PNG 文件');
        const width = view.getUint32(16), height = view.getUint32(20);
        if (width !== height || width < 16 || width > 256) throw new Error('PNG 必须是 16–256 px 的正方形');
        const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        try {
          const target = document.createElement('canvas'); target.width = target.height = 16;
          const context = target.getContext('2d'); context.imageSmoothingEnabled = false; context.drawImage(img, 0, 0, 16, 16);
          const data = context.getImageData(0, 0, 16, 16).data;
          imported = { ...draft, appearance: { version: 1, size: 16, pixels: Array.from({ length: 256 }, (_, i) => data[i * 4 + 3] < 128 ? null : '#' + Array.from(data.slice(i * 4, i * 4 + 3), n => n.toString(16).padStart(2, '0')).join('').toUpperCase()) } };
        } finally { img.close(); }
      } else {
        if (file.size > PET_FILE_LIMIT) throw new Error('宠物文件不能超过 64 KB');
        imported = parsePetFile(await file.text());
      }
      if (!dialog.isConnected) return;
      snapshot(); draft = imported; fields(); draw(); message('外观已导入预览，点击保存后应用到搭档。');
    } catch (error) { if (dialog.isConnected) message(error.message || '文件读取失败', true); }
    finally { busy = false; if (dialog.isConnected) { dialog.querySelectorAll('button,input,select').forEach(element => element.disabled = false); draw(); } }
  });
  listen(q('[data-pe="save"]'), 'click', async () => {
    if (busy) return;
    try {
      const data = parsePetFile(exportPet(draft)); if (typeof onSave !== 'function') throw new Error('保存接口尚未连接');
      busy = true; dialog.querySelectorAll('button,input,select').forEach(e => e.disabled = true); message('正在保存搭档外观…');
      await onSave(data); busy = false; dialog.close();
    } catch (error) { busy = false; dialog.querySelectorAll('button,input,select').forEach(e => e.disabled = false); draw(); message(error.message || '保存失败，请重试', true); }
  });
  fields(); draw(); dialog.showModal(); q('#pe-name').focus();
}
