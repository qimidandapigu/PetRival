import { petDisplayName } from '/shared/pet.mjs';
import { PET_SPECIES, SPECIES_LABELS, PET_FILE_LIMIT, defaultAppearance, validateAppearance, petMarkup, exportPet, parsePetFile } from '/shared/pet.mjs';
import { encodeLook, decodeLook, validateLook, imagePlacement, pixelsFromRgba } from '/shared/pet-studio.mjs';

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
  let draft = { name: petDisplayName(pet.name), species: PET_SPECIES.includes(pet.species) ? pet.species : 'xiaotangyuan', appearance: validateAppearance(pet.appearance ?? defaultAppearance(pet.species)) };
  let brush = '#FFFAE9', history = [], drawing = false, lastCell = -1, cursor = 0, busy = false, sourceImage = null, cropArt = null, dragging = null;
  const previousKey = `petrival-previous-look:${pet.id || 'local'}`;
  let previousLook = null;
  try { previousLook = validateLook(JSON.parse(localStorage.getItem(previousKey))); } catch { /* No saved previous look. */ }
  const previousFocus = document.activeElement, controller = new AbortController(), signal = controller.signal;
  const dialog = document.createElement('dialog'); activeEditor = dialog;
  dialog.id = 'pet-editor'; dialog.className = 'pet-editor'; dialog.setAttribute('aria-labelledby', 'pet-editor-title');
  dialog.innerHTML = `<div class="pe-header"><div><span class="eyebrow">A LOOK OF YOUR OWN</span><h2 id="pet-editor-title">外观工作室</h2><p>自己画一个，或把喜欢的图片粘贴进来。</p></div><button type="button" data-pe="close" aria-label="关闭外观编辑器">×</button></div>
    <div class="pe-body"><div class="pe-drawing"><div class="pe-drop"><strong>把图片带进来</strong><p>在这里按 Ctrl+V，或拖入图片</p><button type="button" data-pe="import">选择图片 / 外观文件</button><input data-pe="file" type="file" accept=".json,.png,.jpg,.jpeg,.webp,application/json,image/png,image/jpeg,image/webp" hidden><small>PNG、JPG、WebP · 最大 8 MB</small></div>
    <div class="pe-crop" hidden><h3>调整图片</h3><canvas class="pe-crop-canvas" width="320" height="320" aria-label="裁剪画布，可拖动调整图片位置"></canvas><p class="pe-help">拖动图片，或用滑块调整。方框内就是保留的范围。</p><label for="pe-zoom">缩放<input id="pe-zoom" type="range" min="1" max="4" step="0.05" value="1"></label><label for="pe-x">左右位置<input id="pe-x" type="range" min="-150" max="150" value="0"></label><label for="pe-y">上下位置<input id="pe-y" type="range" min="-150" max="150" value="0"></label><label class="pe-check"><input id="pe-background" type="checkbox">去除边缘同色背景</label><p class="pe-help">适合纯色背景；复杂背景可转入画板后用橡皮细修。</p><div class="pe-crop-actions"><button type="button" class="primary" data-pe="crop-use">用这张图继续画</button><button type="button" data-pe="crop-cancel">取消图片</button></div></div>
    <div class="pe-painting"><h3>一格一格，画出你的搭档</h3><canvas class="pe-canvas" width="320" height="320" tabindex="0" aria-label="像素画板：方向键移动，空格绘制。也可点击或拖动绘制。"></canvas><p class="pe-help">16 × 16 像素 · 点击或拖动绘制 · 右键擦除<br>键盘：方向键选格，空格上色</p><div class="pe-tools"><button type="button" data-pe="paint" aria-pressed="true">画笔</button><button type="button" data-pe="erase" aria-pressed="false">橡皮</button><button type="button" data-pe="undo" disabled>撤销</button><button type="button" data-pe="reset">恢复预设</button></div><label class="pe-check"><input id="pe-mirror" type="checkbox">左右对称绘制</label><label for="pe-color">画笔颜色</label><div class="pe-palette">${COLORS.map(c => `<button type="button" data-color="${c}" aria-label="颜色 ${c}" title="${c}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="${c}"/></svg></button>`).join('')}</div><label class="pe-color-label" for="pe-color">自选颜色<input id="pe-color" type="color" value="#fffae9"></label></div></div>
    <div class="pe-settings"><h3>回到小院，会是这个样子</h3><div class="pe-preview" aria-label="宠物外观预览"></div><p class="pe-help">小院走动、聊天头像、推箱子都会使用新形象。</p><label for="pe-name">搭档的名字</label><input id="pe-name" maxlength="32" autocomplete="off"><label for="pe-species">从一个预设开始</label><select id="pe-species">${PET_SPECIES.map(s => `<option value="${s}">${SPECIES_LABELS[s]}</option>`).join('')}</select><p class="pe-help">切换预设会替换画布，可撤销。</p><button type="button" data-pe="previous">换回上次外观</button>
    <div class="pe-share"><h3>把外观分享给朋友</h3><p class="pe-help">复制一段外观码，朋友粘贴后就能用。只分享样子，不会带走名字或成长记录。</p><button type="button" data-pe="copy">复制当前外观码</button><label for="pe-code">粘贴外观码</label><textarea id="pe-code" rows="3" maxlength="16384" placeholder="PETLOOK1.…" spellcheck="false"></textarea><button type="button" data-pe="code-use">预览这个外观</button></div>
    <details class="pe-files"><summary>文件导入与导出</summary><p class="pe-help">上方可导入旧版 JSON 外观文件，保留当前宠物名字。</p><div><button type="button" data-pe="json">导出 JSON</button><button type="button" data-pe="png">导出透明 PNG</button></div></details></div></div>
    <div class="pe-footer"><p class="pe-message" role="status" aria-live="polite">先预览，满意再应用。等级、技能和聊天记录都会保留。</p><div><button type="button" data-pe="cancel">取消</button><button type="button" class="primary" data-pe="save">应用外观</button></div></div>`;
  document.body.append(dialog);
  const q = s => dialog.querySelector(s), canvas = q('.pe-canvas'), ctx = canvas.getContext('2d');
  const listen = (target, type, handler, opts = {}) => target.addEventListener(type, handler, { ...opts, signal });
  const message = (text, error = false) => { if (!dialog.isConnected) return; q('.pe-message').textContent = text; q('.pe-message').classList.toggle('pe-error', error); };
  function snapshot() { history.push(structuredClone(draft)); if (history.length > 64) history.shift(); }
  function fields() { q('#pe-name').value = draft.name; q('#pe-species').value = draft.species; }
  function preview() {
    const shown = { ...draft, appearance: cropArt || draft.appearance };
    q('.pe-preview').innerHTML = `<div class="pe-yard"><span class="pe-yard-label">小院 · 走动预览</span><span class="pe-preview-house" aria-hidden="true">⌂</span><span class="pe-walker">${petMarkup(shown, 'pe-preview-pet')}</span></div><div class="pe-preview-scenes"><div>${petMarkup(shown, 'tiny')}<span>聊天头像</span></div><div class="pe-board-preview">${petMarkup(shown, 'small-pet')}<span>推箱子</span></div></div>`;
  }
  function draw() {
    ctx.clearRect(0, 0, 320, 320);
    draft.appearance.pixels.forEach((color, i) => { const x = i % 16, y = Math.floor(i / 16); ctx.fillStyle = color || ((x + y) % 2 ? '#E8EADC' : '#F5F4EC'); ctx.fillRect(x * 20, y * 20, 20, 20); });
    ctx.strokeStyle = '#54634225'; ctx.lineWidth = 1;
    for (let n = 0; n <= 16; n++) { ctx.beginPath(); ctx.moveTo(n * 20, 0); ctx.lineTo(n * 20, 320); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, n * 20); ctx.lineTo(320, n * 20); ctx.stroke(); }
    if (document.activeElement === canvas) { ctx.strokeStyle = '#284936'; ctx.lineWidth = 2; ctx.strokeRect(cursor % 16 * 20 + 1, Math.floor(cursor / 16) * 20 + 1, 18, 18); }
    preview(); q('[data-pe="undo"]').disabled = busy || !history.length;
    q('[data-pe="previous"]').disabled = busy || !previousLook;
    q('[data-pe="save"]').disabled = busy || !!sourceImage;
    q('#pe-species').disabled = busy || !!sourceImage;
    q('[data-pe="code-use"]').disabled = busy || !!sourceImage;
    q('[data-pe="previous"]').disabled ||= !!sourceImage;
    q('[data-pe="paint"]').setAttribute('aria-pressed', String(brush !== null)); q('[data-pe="erase"]').setAttribute('aria-pressed', String(brush === null));
    dialog.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === brush)));
  }
  function close() { if (busy) return; dialog.close(); }
  listen(dialog, 'close', () => { controller.abort(); sourceImage?.close(); dialog.remove(); activeEditor = null; previousFocus?.focus(); });
  listen(dialog, 'cancel', e => { e.preventDefault(); close(); });
  listen(q('[data-pe="close"]'), 'click', close);
  listen(q('[data-pe="cancel"]'), 'click', close);
  listen(q('#pe-name'), 'input', () => { draft.name = q('#pe-name').value; });
  listen(q('#pe-species'), 'change', () => { snapshot(); draft.species = q('#pe-species').value; draft.appearance = defaultAppearance(draft.species); draw(); });
  listen(q('[data-pe="reset"]'), 'click', () => { snapshot(); draft.appearance = defaultAppearance(draft.species); draw(); });
  listen(q('[data-pe="undo"]'), 'click', () => { if (history.length) { draft = history.pop(); fields(); draw(); message('已撤销上一步修改。'); } });
  listen(q('[data-pe="paint"]'), 'click', () => { brush = q('#pe-color').value.toUpperCase(); draw(); });
  listen(q('[data-pe="erase"]'), 'click', () => { brush = null; draw(); });
  listen(q('#pe-color'), 'input', () => { brush = q('#pe-color').value.toUpperCase(); draw(); });
  dialog.querySelectorAll('[data-color]').forEach(b => listen(b, 'click', () => { brush = b.dataset.color; q('#pe-color').value = brush; draw(); }));
  function paint(e) {
    const rect = canvas.getBoundingClientRect(), x = Math.floor((e.clientX - rect.left) / rect.width * 16), y = Math.floor((e.clientY - rect.top) / rect.height * 16);
    if (x < 0 || y < 0 || x >= 16 || y >= 16) return;
    const cell = y * 16 + x; if (cell === lastCell) return; lastCell = cursor = cell;
    setPixel(cell, e.buttons === 2 ? null : brush); draw();
  }
  function setPixel(cell, color) { draft.appearance.pixels[cell] = color; if (q('#pe-mirror').checked) draft.appearance.pixels[Math.floor(cell / 16) * 16 + 15 - cell % 16] = color; }
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
    if (e.key === ' ') { e.preventDefault(); snapshot(); setPixel(cursor, brush); draw(); }
  }, { capture: true });
  listen(q('[data-pe="json"]'), 'click', () => { try { const data = exportPet({ ...draft, appearance: cropArt || draft.appearance }); download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'petrival-pet.json'); message('已导出宠物外观 JSON。'); } catch (e) { message(e.message, true); } });
  listen(q('[data-pe="png"]'), 'click', () => bitmap(cropArt || draft.appearance).toBlob(blob => { if (blob) { download(blob, 'petrival-pet-16x16.png'); message('已导出 16 × 16 透明背景 PNG。'); } }, 'image/png'));
  listen(q('[data-pe="import"]'), 'click', () => q('[data-pe="file"]').click());
  function lock(value) { busy = value; drawing = false; dialog.querySelectorAll('button,input,select,textarea').forEach(el => el.disabled = value); draw(); }
  function discardImage() { sourceImage?.close(); sourceImage = cropArt = null; dragging = null; q('.pe-crop').hidden = true; q('.pe-painting').hidden = false; draw(); }
  function applyLook(look) { snapshot(); draft = { ...draft, ...validateLook({ species: look.species, appearance: look.appearance }) }; fields(); draw(); }
  function renderCrop() {
    if (!sourceImage) return;
    const target = q('.pe-crop-canvas'), context = target.getContext('2d');
    const zoom = Number(q('#pe-zoom').value), x = Number(q('#pe-x').value), y = Number(q('#pe-y').value);
    const rect = imagePlacement(sourceImage.width, sourceImage.height, zoom, x, y);
    context.clearRect(0, 0, 320, 320); context.imageSmoothingEnabled = false;
    context.drawImage(sourceImage, rect.x, rect.y, rect.width, rect.height);
    const small = document.createElement('canvas'); small.width = small.height = 16;
    const smallContext = small.getContext('2d'), pixelRect = imagePlacement(sourceImage.width, sourceImage.height, zoom, x, y, 16);
    smallContext.imageSmoothingEnabled = false; smallContext.drawImage(sourceImage, pixelRect.x, pixelRect.y, pixelRect.width, pixelRect.height);
    cropArt = pixelsFromRgba(smallContext.getImageData(0, 0, 16, 16).data, q('#pe-background').checked); preview();
  }
  async function importFile(file) {
    if (!file || busy) return;
    lock(true); message('正在读取外观文件…');
    try {
      if (/\.json$/i.test(file.name) || file.type === 'application/json') {
        if (file.size > PET_FILE_LIMIT) throw new Error('宠物文件不能超过 64 KB');
        const imported = parsePetFile(await file.text()); discardImage(); applyLook(imported);
        message('已导入外观，保留当前名字。满意后点击「应用外观」。');
      } else {
        if (file.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MB');
        const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
        const png = header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71;
        const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
        const webp = String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
        if (!png && !jpeg && !webp) throw new Error('请选择 PNG、JPG 或 WebP 图片，也可以导入外观 JSON');
        const img = await createImageBitmap(file);
        if (img.width > 4096 || img.height > 4096) { img.close(); throw new Error('图片宽高请控制在 4096 px 以内'); }
        sourceImage?.close(); sourceImage = img;
        q('#pe-zoom').value = '1'; q('#pe-x').value = q('#pe-y').value = '0'; q('#pe-background').checked = false;
        q('.pe-crop').hidden = false; q('.pe-painting').hidden = true; renderCrop();
        message('图片已收到！调整方框里的位置，右侧会预览最终像素效果。');
        q('.pe-crop').scrollIntoView({ block: 'nearest' });
      }
    } catch (error) { message(error.message || '图片读取失败，请换一张试试', true); }
    finally { lock(false); }
  }
  listen(q('[data-pe="file"]'), 'change', e => { const file = e.target.files?.[0]; e.target.value = ''; void importFile(file); });
  for (const id of ['#pe-zoom', '#pe-x', '#pe-y', '#pe-background']) listen(q(id), 'input', renderCrop);
  const cropCanvas = q('.pe-crop-canvas');
  listen(cropCanvas, 'pointerdown', e => { if (busy || !sourceImage || e.button !== 0) return; e.preventDefault(); cropCanvas.setPointerCapture(e.pointerId); dragging = { x: e.clientX, y: e.clientY, startX: Number(q('#pe-x').value), startY: Number(q('#pe-y').value) }; });
  listen(cropCanvas, 'pointermove', e => { if (!dragging || busy) return; const width = cropCanvas.getBoundingClientRect().width; q('#pe-x').value = String(dragging.startX + (e.clientX - dragging.x) / width * 200); q('#pe-y').value = String(dragging.startY + (e.clientY - dragging.y) / width * 200); renderCrop(); });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(cropCanvas, event, () => { dragging = null; });
  listen(q('[data-pe="crop-use"]'), 'click', () => { if (!cropArt || busy) return; if (!cropArt.pixels.some(Boolean)) { message('预览中没有可见像素，请调整位置或关闭去背景。', true); return; } snapshot(); draft.appearance = cropArt; discardImage(); message('图片已放入画板，可以继续细修，或点击「应用外观」。'); });
  listen(q('[data-pe="crop-cancel"]'), 'click', () => { discardImage(); message('已取消图片，原来的画布还在。'); });
  listen(dialog, 'dragover', e => { e.preventDefault(); q('.pe-drop').classList.add('pe-dragging'); });
  listen(dialog, 'dragleave', e => { if (!dialog.contains(e.relatedTarget)) q('.pe-drop').classList.remove('pe-dragging'); });
  listen(dialog, 'drop', e => { e.preventDefault(); q('.pe-drop').classList.remove('pe-dragging'); void importFile(e.dataTransfer?.files?.[0]); });
  listen(dialog, 'paste', e => {
    const file = Array.from(e.clipboardData?.items || []).find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (file) { e.preventDefault(); void importFile(file); return; }
    const text = e.clipboardData?.getData('text/plain') || '';
    if (text.trim().startsWith('PETLOOK1.') && e.target !== q('#pe-name')) { e.preventDefault(); if (!busy) { q('#pe-code').value = text.slice(0, 16384); message('外观码已粘贴，点击「预览这个外观」查看。'); } }
  });
  listen(q('[data-pe="code-use"]'), 'click', () => { try { applyLook(decodeLook(q('#pe-code').value)); message('外观码已载入预览，满意后点击「应用外观」。'); } catch (error) { message(error.message, true); } });
  listen(q('[data-pe="copy"]'), 'click', async () => {
    try {
      const code = encodeLook({ ...draft, appearance: cropArt || draft.appearance }); q('#pe-code').value = code;
      try { await navigator.clipboard.writeText(code); message('外观码已复制，可以发给朋友了。'); }
      catch { q('#pe-code').focus(); q('#pe-code').select(); message('外观码已选中，按 Ctrl+C 即可复制。'); }
    } catch (error) { message(error.message, true); }
  });
  listen(q('[data-pe="previous"]'), 'click', () => { if (previousLook) { applyLook(previousLook); message('已预览上次外观，点击「应用外观」换回。'); } });
  listen(q('[data-pe="save"]'), 'click', async () => {
    if (busy || sourceImage) return;
    try {
      const data = parsePetFile(exportPet(draft)); if (typeof onSave !== 'function') throw new Error('保存接口尚未连接');
      lock(true); message('正在保存搭档外观…');
      await onSave(data);
      try { localStorage.setItem(previousKey, JSON.stringify({ species: pet.species, appearance: pet.appearance ?? defaultAppearance(pet.species) })); } catch { /* Saving appearance succeeds even if local history storage is unavailable. */ }
      busy = false; dialog.close();
    } catch (error) { lock(false); message(error.message || '保存失败，请重试', true); }
  });
  fields(); draw(); dialog.showModal(); q('[data-pe="import"]').focus();
}
