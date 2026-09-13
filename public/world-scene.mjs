import { defaultAppearance } from '/shared/pet.mjs';
import { lifePosition } from '/shared/life.mjs';

// An original, code-drawn little farm. All coordinates are in a 384 × 256
// pixel world; the canvas keeps a fixed 2× backing store at every CSS size.
const W = 384, H = 256;
const C = {
  grass: '#a6bc70', light: '#b9ca7d', dark: '#8ca865', tuft: '#91ac64',
  path: '#dfca99', pathEdge: '#c6b480', pathLight: '#ead9ad',
  forest: '#52785a', leaf: '#688e59', leafLight: '#89a460', leafDeep: '#42664c',
  wood: '#9b714b', woodLight: '#c79a65', woodDark: '#72563f',
};
// Scene clicks only navigate; pet activities come from conversation and routine.
const HOTSPOTS = [
  { id: 'game', x: 304, y: 57, w: 33, h: 35 },
];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const seeded = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const rect = (ctx, x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
function polygon(ctx, points, color) {
  ctx.fillStyle = color; ctx.beginPath();
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fill();
}
function ellipse(ctx, x, y, rx, ry, color) {
  // Horizontal strips keep even round silhouettes faithful to the pixel grid.
  for (let yy = -ry; yy <= ry; yy += 2) {
    const xx = Math.max(1, Math.floor(rx * Math.sqrt(Math.max(0, 1 - (yy / ry) ** 2))));
    rect(ctx, x - xx, y + yy, xx * 2, 2, color);
  }
}
function flower(ctx, x, y, color = '#f2e1a0') {
  rect(ctx, x, y + 2, 1, 3, '#718b51'); rect(ctx, x - 1, y, 3, 3, color); rect(ctx, x, y + 1, 1, 1, '#ba8c53');
}
function grass(ctx, x, y, color = C.tuft) {
  rect(ctx, x, y, 1, 3, color); rect(ctx, x - 2, y - 1, 1, 2, color); rect(ctx, x + 2, y + 1, 1, 2, color);
}
function tree(ctx, x, y, scale = 1, variant = 0) {
  ctx.save(); ctx.translate(Math.round(x), Math.round(y)); ctx.scale(scale, scale);
  ellipse(ctx, 3, 2, 17, 5, '#79945a');
  rect(ctx, -3, -19, 6, 23, '#795b43'); rect(ctx, -1, -18, 2, 21, '#ae8156');
  rect(ctx, -6, 1, 4, 3, '#795b43'); rect(ctx, 3, 1, 4, 2, '#795b43');
  const palette = variant % 2 ? ['#587c50', '#759350', '#96ab62'] : ['#4e7956', '#638b55', '#8aa45c'];
  const shape = [[-13,-23],[-18,-23],[-18,-34],[-15,-34],[-15,-43],[-10,-43],[-10,-50],[-3,-50],[-3,-54],[7,-54],[7,-50],[14,-50],[14,-43],[19,-43],[19,-33],[21,-33],[21,-24],[16,-24],[16,-19],[-8,-19],[-8,-21],[-13,-21]];
  polygon(ctx, shape, C.leafDeep);
  polygon(ctx, [[-16,-34],[-13,-44],[-8,-44],[-8,-49],[0,-49],[0,-52],[6,-52],[6,-47],[12,-47],[12,-41],[17,-41],[17,-29],[13,-29],[13,-24],[-8,-24],[-8,-27],[-16,-27]], palette[0]);
  polygon(ctx, [[-13,-35],[-10,-44],[-6,-44],[-6,-48],[4,-48],[4,-44],[10,-44],[10,-36],[14,-36],[14,-30],[-9,-30],[-9,-32],[-13,-32]], palette[1]);
  rect(ctx, -7, -45, 8, 3, palette[2]); rect(ctx, -11, -39, 5, 3, palette[2]);
  rect(ctx, 3, -38, 6, 2, palette[2]); rect(ctx, -5, -29, 5, 2, palette[1]);
  rect(ctx, 13, -28, 3, 2, '#577748'); rect(ctx, -12, -26, 3, 2, '#577748');
  if (variant === 2) { rect(ctx, -8, -35, 3, 3, '#d6a260'); rect(ctx, 10, -31, 3, 3, '#d78d54'); rect(ctx, 2, -44, 3, 3, '#e0ad62'); }
  ctx.restore();
}
function bush(ctx, x, y, width = 14, flowers = false) {
  ellipse(ctx, x, y, width, 4, '#819b5c'); ellipse(ctx, x, y - 5, width - 2, 7, '#6c9158');
  rect(ctx, x - width + 5, y - 10, 8, 2, '#92ad64'); rect(ctx, x + 2, y - 6, 5, 2, '#8ca45e');
  if (flowers) { flower(ctx, x - 7, y - 9, '#e8a7a0'); flower(ctx, x + 4, y - 5, '#ebd9a2'); }
}
function fence(ctx, x, y, length, vertical = false) {
  if (vertical) {
    rect(ctx, x + 1, y, 3, length, '#8b7049'); rect(ctx, x + 5, y, 2, length, '#c5a16b');
    for (let yy = y; yy <= y + length; yy += 14) {
      rect(ctx, x, yy - 7, 7, 11, '#876c48'); rect(ctx, x, yy - 8, 5, 10, '#d1ad75'); rect(ctx, x + 1, yy - 8, 2, 10, '#e0bf87');
    }
  } else {
    rect(ctx, x, y - 6, length, 3, '#92744d'); rect(ctx, x, y - 6, length, 1, '#d3b17a'); rect(ctx, x, y - 1, length, 2, '#b5905b');
    for (let xx = x; xx <= x + length; xx += 14) {
      rect(ctx, xx, y - 11, 5, 16, '#9a7a4f'); rect(ctx, xx, y - 12, 4, 15, '#d6b37b'); rect(ctx, xx + 1, y - 13, 2, 2, '#e4c68e');
    }
  }
}
function path(ctx, points, width = 15) {
  ctx.lineCap = 'square'; ctx.lineJoin = 'round';
  const draw = (stroke, size) => { ctx.strokeStyle = stroke; ctx.lineWidth = size; ctx.beginPath(); points.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.stroke(); };
  draw(C.pathEdge, width + 3); draw(C.path, width);
}
function pot(ctx, x, y, color = '#d58364') {
  rect(ctx, x - 4, y - 5, 8, 6, '#a2634d'); rect(ctx, x - 3, y - 5, 5, 5, color); rect(ctx, x - 5, y - 7, 10, 3, '#c9805e');
  rect(ctx, x - 1, y - 15, 2, 9, '#56794f'); rect(ctx, x - 5, y - 14, 4, 3, '#729557'); rect(ctx, x + 1, y - 17, 4, 3, '#88a45d');
  flower(ctx, x, y - 19, '#edd99e');
}
function house(ctx) {
  // House ground shadow, plaster walls and a wraparound wooden porch.
  polygon(ctx, [[52,86],[153,86],[167,119],[144,128],[55,117]], '#809a60');
  rect(ctx, 62, 71, 81, 42, '#9b8060'); rect(ctx, 64, 74, 64, 38, '#ead4a1'); rect(ctx, 128, 73, 16, 40, '#cbb183');
  rect(ctx, 64, 86, 64, 3, '#ddc38f'); rect(ctx, 129, 78, 13, 1, '#b79c77'); rect(ctx, 129, 92, 13, 1, '#b79c77'); rect(ctx, 129, 104, 13, 1, '#b79c77');
  rect(ctx, 59, 110, 89, 10, '#94704d'); rect(ctx, 60, 110, 87, 7, '#c9a572');
  for (let x = 63; x < 147; x += 7) rect(ctx, x, 110, 1, 7, '#b18c5e');
  rect(ctx, 90, 117, 32, 3, '#8f6d4b'); rect(ctx, 92, 120, 28, 3, '#c9aa7c'); rect(ctx, 92, 122, 28, 1, '#a78b60');
  rect(ctx, 96, 87, 17, 24, '#775944'); rect(ctx, 98, 89, 13, 22, '#ad8158'); rect(ctx, 100, 92, 9, 8, '#769391');
  rect(ctx, 102, 92, 2, 8, '#ecd8a6'); rect(ctx, 100, 95, 9, 1, '#ecd8a6'); rect(ctx, 108, 104, 2, 2, '#edcf8c');
  const window = (x, y) => {
    rect(ctx, x - 2, y - 2, 18, 18, '#a5825e'); rect(ctx, x, y, 14, 12, '#eddfa9'); rect(ctx, x + 2, y + 1, 10, 10, '#729393');
    rect(ctx, x + 2, y + 1, 4, 4, '#a6b8a7'); rect(ctx, x + 6, y, 2, 12, '#efdaad'); rect(ctx, x, y + 5, 14, 2, '#efdaad');
    rect(ctx, x - 3, y + 13, 20, 3, '#b1865c'); rect(ctx, x - 4, y + 10, 2, 5, '#769455'); rect(ctx, x + 16, y + 10, 2, 5, '#789b5a');
  };
  window(73, 89); window(120, 89);
  // Stepped roof silhouette and individual staggered clay shingles.
  polygon(ctx, [[51,77],[55,72],[58,67],[62,61],[66,55],[69,48],[133,48],[137,54],[141,60],[145,66],[149,72],[154,77],[154,82],[51,82]], '#845744');
  polygon(ctx, [[52,75],[58,68],[64,57],[70,47],[133,47],[138,57],[145,68],[153,77],[53,77]], '#b9674e');
  polygon(ctx, [[59,70],[66,55],[71,46],[132,46],[138,58],[146,71]], '#ce8060');
  rect(ctx, 70, 44, 63, 4, '#e1a47a'); rect(ctx, 73, 44, 57, 1, '#f0bc8c');
  for (let y = 51; y < 76; y += 6) {
    const left = 70 - Math.floor((y - 47) * .55), right = 132 + Math.floor((y - 47) * .6);
    rect(ctx, left, y + 3, right - left, 1, '#aa614c');
    for (let x = left + (y % 12 ? 3 : 7); x < right - 3; x += 10) { rect(ctx, x, y, 1, 4, '#ad654d'); rect(ctx, x + 2, y, 5, 1, '#df9670'); }
  }
  rect(ctx, 51, 78, 103, 3, '#855a44'); rect(ctx, 53, 78, 99, 1, '#e1a276');
  // Chimney and little attic dormer.
  rect(ctx, 119, 35, 10, 18, '#aa7e64'); rect(ctx, 119, 36, 7, 17, '#c79778'); rect(ctx, 118, 34, 12, 4, '#957159'); rect(ctx, 119, 34, 10, 1, '#dcbaa0');
  rect(ctx, 122, 40, 6, 1, '#a27660'); rect(ctx, 119, 45, 5, 1, '#a27660');
  rect(ctx, 88, 61, 21, 16, '#e0bd8b'); polygon(ctx, [[85,62],[98,49],[112,62]], '#895a46'); polygon(ctx, [[86,60],[98,48],[111,60]], '#dc9771');
  rect(ctx, 92, 62, 13, 12, '#9a7859'); rect(ctx, 94, 64, 9, 8, '#75938c'); rect(ctx, 98, 64, 1, 8, '#e3cfa0'); rect(ctx, 94, 67, 9, 1, '#e3cfa0');
  rect(ctx, 58, 81, 3, 31, '#886d4d'); rect(ctx, 145, 81, 3, 31, '#886d4d');
  rect(ctx, 61, 84, 2, 7, '#e6bd6b'); rect(ctx, 60, 86, 4, 4, '#ebd59c');
  pot(ctx, 68, 112); pot(ctx, 138, 112, '#be8163');
  bush(ctx, 48, 110, 13, true); bush(ctx, 155, 112, 10, true);
}
function gardenBase(ctx) {
  rect(ctx, 215, 72, 76, 51, '#89a35f');
  fence(ctx, 214, 71, 73); fence(ctx, 211, 77, 43, true); fence(ctx, 293, 77, 43, true);
  // Two cultivated beds with a walkable aisle.
  for (const x of [221, 260]) {
    rect(ctx, x, 78, 28, 41, '#9c7550'); rect(ctx, x + 1, 80, 26, 37, '#aa8257');
    for (let y = 83; y < 116; y += 10) { rect(ctx, x + 3, y + 3, 22, 3, '#8f6c4a'); rect(ctx, x + 4, y, 20, 1, '#bd9563'); }
    rect(ctx, x, 118, 28, 2, '#8b6c47');
  }
  rect(ctx, 250, 78, 8, 40, '#c5b77d');
  // Trellis with flowering beans, a barrel and watering can.
  rect(ctx, 228, 59, 2, 18, '#98754e'); rect(ctx, 276, 59, 2, 18, '#98754e'); rect(ctx, 226, 58, 54, 3, '#bd9b65');
  for (let x = 235; x < 276; x += 10) { rect(ctx, x, 60, 1, 12, '#c5aa76'); rect(ctx, x - 2, 63, 4, 3, '#6a8d50'); flower(ctx, x + 1, 66, '#c9a5b6'); }
  rect(ctx, 301, 108, 12, 15, '#986d48'); rect(ctx, 301, 109, 10, 12, '#b98b58');
  rect(ctx, 300, 110, 13, 2, '#697365'); rect(ctx, 300, 119, 13, 2, '#697365'); rect(ctx, 303, 107, 7, 2, '#d0a66b');
  rect(ctx, 283, 124, 6, 5, '#69938c'); rect(ctx, 288, 122, 4, 2, '#6d958c'); rect(ctx, 282, 122, 4, 2, '#93b0a0');
}
function picnic(ctx) {
  ellipse(ctx, 82, 196, 35, 10, '#92a662');
  polygon(ctx, [[63,181],[103,181],[112,205],[71,205]], '#b97d60');
  polygon(ctx, [[65,181],[104,181],[110,202],[71,202]], '#dfb187');
  for (let i = 0; i < 4; i++) { rect(ctx, 70 + i * 9, 185, 3, 15, '#eaca9c'); rect(ctx, 68, 185 + i * 5, 38, 2, '#f0d4a5'); }
  rect(ctx, 79, 180, 14, 9, '#a97b4d'); rect(ctx, 80, 179, 12, 3, '#cea16a'); rect(ctx, 82, 175, 7, 2, '#ad8051'); rect(ctx, 81, 176, 2, 4, '#ad8051'); rect(ctx, 89, 176, 2, 4, '#ad8051');
  rect(ctx, 96, 191, 5, 4, '#f4e6c1'); rect(ctx, 101, 192, 2, 2, '#f4e6c1'); rect(ctx, 97, 191, 3, 1, '#a37455');
  rect(ctx, 75, 194, 10, 3, '#eddbb8'); rect(ctx, 78, 192, 5, 2, '#d49b65');
  // Wooden bench sits next to the feeding place.
  rect(ctx, 115, 169, 21, 3, '#886c49'); rect(ctx, 115, 174, 21, 3, '#886c49'); rect(ctx, 113, 179, 26, 4, '#c29a66');
  rect(ctx, 116, 168, 2, 20, '#9a7b52'); rect(ctx, 134, 168, 2, 20, '#9a7b52'); rect(ctx, 113, 180, 26, 1, '#ddba82');
  ellipse(ctx, 123, 195, 6, 2, '#d3c8a1'); rect(ctx, 118, 191, 10, 4, '#ac815c'); rect(ctx, 119, 191, 8, 1, '#ddab71');
}
const POND = [[284,164],[319,159],[340,168],[349,179],[358,186],[363,210],[351,223],[331,230],[298,226],[281,216],[273,198],[274,180]];
function pondBase(ctx) {
  ctx.save(); ctx.translate(13,22);
  polygon(ctx, POND.map(([x,y]) => [x,y+4]), '#89a266'); polygon(ctx, POND, '#c4bc86');
  polygon(ctx, [[285,171],[319,165],[337,173],[344,183],[352,189],[357,209],[346,217],[330,223],[300,220],[285,210],[279,196],[280,181]], '#669c97');
  polygon(ctx, [[290,175],[319,170],[334,177],[342,188],[350,195],[350,208],[338,215],[308,216],[291,207],[284,193],[284,183]], '#7aada3');
  polygon(ctx, [[282,191],[286,185],[290,183],[303,183],[310,180],[329,182],[336,190],[344,194],[347,208],[335,214],[307,213],[294,206],[288,201]], '#82b7aa');
  rect(ctx, 291, 177, 16, 2, '#a8c9af'); rect(ctx, 286, 183, 7, 1, '#a8c9af');
  // A few broad stepping stones along the bank.
  for (const [x,y,w] of [[276,177,6],[337,166,7],[359,207,7],[333,228,7],[279,213,8]]) { rect(ctx,x,y,w,4,'#919b80'); rect(ctx,x,y,w-1,2,'#bbc0a0'); }
  for (const [x,y] of [[283,171],[350,217],[358,202],[312,226],[269,196],[339,171]]) {
    rect(ctx,x,y-10,1,12,'#6b8555'); rect(ctx,x+3,y-13,1,13,'#72945b'); rect(ctx,x-3,y-7,1,7,'#7e985f'); rect(ctx,x+2,y-14,3,5,'#a38154');
  }
  ctx.restore();
}
function gameSign(ctx) {
  ellipse(ctx, 321, 88, 14, 4, '#839f60'); rect(ctx, 319, 69, 3, 19, '#8b6949');
  rect(ctx, 305, 58, 31, 20, '#755d45'); rect(ctx, 306, 57, 29, 19, '#d1ae75'); rect(ctx, 308, 59, 25, 15, '#b58c5b');
  rect(ctx, 310, 60, 22, 1, '#e1c48a');
  // Crate + arrow is the sign for the only currently available game.
  rect(ctx, 311, 63, 9, 9, '#765d43'); rect(ctx, 312, 64, 7, 7, '#d9b879'); rect(ctx, 313, 65, 5, 1, '#a27d52'); rect(ctx, 313, 69, 5, 1, '#a27d52'); rect(ctx, 315, 65, 1, 5, '#a27d52');
  rect(ctx, 323, 65, 6, 2, '#f0deb0'); rect(ctx, 327, 63, 2, 6, '#f0deb0'); rect(ctx, 329, 65, 2, 2, '#f0deb0');
  flower(ctx, 332, 86, '#e8c991'); grass(ctx, 310, 88);
}
function terrain(ctx) {
  const rand = seeded(4117); rect(ctx, 0, 0, W, H, C.grass);
  // Broad changes in ground color give a soft, hand-painted field beneath the pixels.
  for (const [x,y,rx,ry,c] of [[78,131,90,34,'#afc477'],[269,88,76,58,'#b5c87a'],[193,208,81,38,'#afc078'],[0,109,51,88,'#98b16b'],[368,95,24,113,'#8fac69'],[170,10,143,16,'#8fab69']]) ellipse(ctx,x,y,rx,ry,c);
  for (let i = 0; i < 300; i++) {
    const x = Math.floor(rand() * W), y = Math.floor(rand() * H);
    if (rand() < .35) grass(ctx,x,y,rand() < .5 ? '#92ad65' : '#9fb56b');
    else rect(ctx,x,y,rand() < .4 ? 3 : 1,1,rand() < .5 ? '#b8c97d' : '#98af69');
  }
  // Paths connect every activity destination through the central clearing.
  path(ctx, [[107,114],[107,130],[130,151],[188,154],[221,154],[252,127]], 15);
  path(ctx, [[177,154],[152,172],[128,180],[115,187]], 13);
  path(ctx, [[219,154],[249,175],[279,176],[299,189]], 13);
  path(ctx, [[253,130],[283,135],[310,116],[319,82]], 11);
  path(ctx, [[187,153],[186,197],[193,228],[193,258]], 18);
  ellipse(ctx, 188,154,25,17,C.pathEdge); ellipse(ctx,188,153,24,16,C.path);
  for (let i = 0; i < 130; i++) {
    const x = Math.floor(rand()*W), y = Math.floor(rand()*H);
    // Path texture is clipped by inspecting the fixed background, never gameplay state.
    const pixel = ctx.getImageData(x*2,y*2,1,1).data;
    if (pixel[0] === 223 && pixel[1] === 202) rect(ctx,x,y,rand()>.5?2:1,1,rand()>.5?'#ceb885':'#efdeb1');
  }
  // A stepping-stone invitation into the farm at the bottom edge.
  for (const [x,y] of [[189,235],[195,245],[189,254]]) { rect(ctx,x-4,y-2,8,4,'#b2ad89'); rect(ctx,x-3,y-2,6,2,'#d4c9a3'); }
  fence(ctx, 172, 47, 131); fence(ctx, 40, 156, 47); fence(ctx, 40, 164, 30, true);
  gardenBase(ctx); pondBase(ctx); picnic(ctx); house(ctx); gameSign(ctx);
  // Little mailbox just outside the porch.
  rect(ctx, 163, 128, 3, 15, '#906c4c'); rect(ctx, 158, 121, 13, 8, '#6d8f83'); rect(ctx, 158, 120, 11, 2, '#9bb0a0'); rect(ctx, 158, 124, 5, 3, '#456a62'); rect(ctx, 170, 118, 2, 8, '#af7856'); rect(ctx, 171, 118, 4, 3, '#dcad70');
  // Rocks, low wildflower patches, a chopped log and a tiny mushroom cluster.
  for (const [x,y] of [[175,91],[205,220],[38,207],[157,219]]) { ellipse(ctx,x,y,5,3,'#8f9c7a'); rect(ctx,x-3,y-2,5,2,'#b6ba92'); }
  for (const [x,y] of [[180,67],[184,73],[192,63],[43,134],[38,142],[51,139],[234,204],[242,207],[247,199],[153,192],[159,198],[334,141],[341,138]]) flower(ctx,x,y,(x+y)%2 ? '#ebdba0' : '#e8b3a0');
  rect(ctx,47,215,18,7,'#8e6c46'); rect(ctx,49,214,14,5,'#b18e59'); rect(ctx,46,215,4,6,'#d2b17b'); rect(ctx,47,217,2,2,'#9f7c51');
  for (const [x,y] of [[153,222],[159,225],[34,113]]) { rect(ctx,x,y,2,4,'#e2cf9c'); rect(ctx,x-2,y-2,6,3,'#c78565'); rect(ctx,x-1,y-2,1,1,'#ecd5a6'); }
  bush(ctx, 171, 50, 12); bush(ctx, 313, 43, 17, true); bush(ctx, 194, 92, 12, true); bush(ctx, 363, 140, 13); bush(ctx, 220, 243, 16,true);
  // Perimeter trees leave the home's silhouette and main walking routes open.
  for (const [x,y,s,v] of [[13,53,1.25,0],[41,40,.95,1],[82,30,.9,0],[171,35,1,1],[208,31,1.08,0],[247,28,1,1],[287,30,.95,0],[346,43,1.16,1],[380,57,1.22,0],[9,103,1.13,1],[375,104,1.06,2],[15,163,1.1,0],[29,239,1.14,1],[65,253,.86,2],[363,262,1.14,0],[385,221,.99,1],[114,268,1.03,0],[258,272,1.05,1]]) tree(ctx,x,y,s,v);
}

function cropPlants(ctx, life, time) {
  const growth = Number.isFinite(life?.crops?.growth) ? clamp(life.crops.growth / 100, 0, 1) : .45;
  const wet = life?.crops?.wateredAt && time - life.crops.wateredAt < 180000;
  for (const start of [225,264]) for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) {
    const x = start + col * 8, y = 86 + row * 9;
    if (wet) rect(ctx,x-2,y+2,6,2,'#805f46');
    rect(ctx,x,y-3,1,7,'#587746'); rect(ctx,x-3,y-2,3,2,'#719253'); rect(ctx,x+1,y-4,3,2,'#82a45c');
    if (growth > .15) { rect(ctx,x-2,y,3,2,'#92ac5b'); rect(ctx,x+1,y-1,3,2,'#63884d'); }
    if (growth > .55) { rect(ctx,x-1,y-4,3,3,start<250?'#e3ae68':'#d29380'); rect(ctx,x,y-4,1,1,'#efcc80'); }
  }
}
function duck(ctx, x, y, flip = false) {
  ctx.save(); ctx.translate(Math.round(x),Math.round(y)); if(flip)ctx.scale(-1,1);
  rect(ctx,-5,4,12,1,'#a6d0b8'); rect(ctx,-4,1,8,4,'#ecdfaf'); rect(ctx,-2,1,4,2,'#faf0c7');
  rect(ctx,2,-3,5,6,'#f2e6b9'); rect(ctx,6,0,3,2,'#dcb36a'); rect(ctx,5,-2,1,1,'#5d7460'); ctx.restore();
}

export function createWorldScene(canvas, { onInteract = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { update() {}, destroy() {} };
  canvas.width = W * 2; canvas.height = H * 2;
  ctx.imageSmoothingEnabled = false;
  const staticCanvas = document.createElement('canvas'); staticCanvas.width = W * 2; staticCanvas.height = H * 2;
  const base = staticCanvas.getContext('2d', { willReadFrequently: true }); base.scale(2,2); terrain(base);
  let pet = null, life = null, clockOffset = 0, frame = null, destroyed = false, lastPaint = 0, hover = null, position = {x:188,y:154};
  let pixels = defaultAppearance().pixels, defaultFace = true;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function petPosition(now) {
    const destination = { x: clamp(Number(life?.location?.x) || .49, .05, .95)*W, y: clamp(Number(life?.location?.y) || .60, .06, .96)*H };
    if (!life?.from || motion.matches) return { ...destination, walking: false };
    const point = lifePosition(life, now);
    const walking = now - life.startedAt < (life.walkMs || 3500);
    return { x: point.x * W, y: point.y * H, walking };
  }

  function paint(now) {
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(staticCanvas,0,0);
    ctx.setTransform(2,0,0,2,0,0);
    const seconds = motion.matches ? 0 : now/1000, season = life?.timeOfDay || 'day';
    cropPlants(ctx,life,now);
    // Floating water highlights and two quiet residents of the pond.
    ctx.save(); ctx.translate(13,22);
    for (let i=0;i<7;i++) {
      const x=293+(i*19%50)+Math.round(Math.sin(seconds*.5+i)*2), y=183+(i*11%28);
      rect(ctx,x,y,5+i%4,1,i%2?'#afd0b8':'#98c4ae');
    }
    duck(ctx,319+Math.sin(seconds*.10)*9,191+Math.cos(seconds*.13)*3);
    duck(ctx,335+Math.sin(seconds*.10+2)*7,207+Math.cos(seconds*.13+2)*2,true);
    ellipse(ctx,293,203,5,2,'#598f71'); rect(ctx,292,200,3,3,'#a0bd75'); flower(ctx,292,199,'#f1cfbc');
    ellipse(ctx,338,182,4,2,'#5d9070'); rect(ctx,339,181,2,1,'#9ab575');
    ctx.restore();
    // Smoke drifts away from the chimney without obscuring the scene.
    for (let i=0;i<3;i++) { const rise=(seconds*.18+i*.33)%1; ctx.globalAlpha=(1-rise)*.26; ellipse(ctx,124+rise*9+Math.sin(seconds+i)*2,31-rise*17,3+Math.floor(rise*3),2,'#f3ecd2'); } ctx.globalAlpha=1;
    if (season!=='night') {
      const butterflyX=203+Math.sin(seconds*.27)*16, butterflyY=100+Math.cos(seconds*.31)*10;
      rect(ctx,butterflyX,butterflyY,1,3,'#8b7856'); rect(ctx,butterflyX-3,butterflyY,2,Math.sin(seconds*8)>0?3:1,'#edcd8e'); rect(ctx,butterflyX+2,butterflyY,2,Math.sin(seconds*8)>0?3:1,'#f3dbaa');
    }
    position=petPosition(now);
    const x=Math.round(position.x), y=Math.round(position.y), bob=position.walking&&!motion.matches ? Math.round(Math.sin(seconds*14)) : 0;
    ellipse(ctx,x,y+3,12,3,'#9e9b70');
    ctx.save();ctx.translate(x-12,y-22+bob);ctx.scale(1.5,1.5);
    const blink=defaultFace&&!motion.matches&&Math.floor(seconds*5)%29===0;
    pixels.forEach((color,index)=>{if(!color)return;const px=index%16,py=Math.floor(index/16);if(blink&&py===8&&(px===5||px===10))color='#FFFAE9';rect(ctx,px,py,1,1,color);});ctx.restore();
    if (pet && !position.walking) {
      if (life?.activity==='rest') {
        const float=motion.matches?0:Math.floor(seconds)%3;
        ctx.font='bold 8px monospace';ctx.fillStyle='#738477';ctx.fillText('z',x+13,y-23-float);ctx.font='bold 6px monospace';ctx.fillText('z',x+20,y-30-float);
      } else if (life?.activity==='water') {
        rect(ctx,x+11,y-5,6,5,'#688f91');rect(ctx,x+16,y-6,5,2,'#688f91');rect(ctx,x+11,y-8,4,2,'#a2b8a7');
        for(let i=0;i<3;i++){const fall=motion.matches?i*2:(seconds*8+i*3)%8;rect(ctx,x+20+i*2,y-2+fall,1,2,'#b6d5cc');}
      } else if (life?.activity==='feed') {
        rect(ctx,x+8,y-3,7,3,'#c9915b');rect(ctx,x+9,y-5,5,2,'#e0bb7b');rect(ctx,x+8,y,7,1,'#906947');
      }
    }
    // Gentle evening tint and warm lit windows make the farm feel inhabited.
    if (season==='evening'||season==='night') {
      rect(ctx,0,0,W,H,season==='night'?'#233f5f60':'#c98b6730');
      for(const [wx,wy,ww,wh] of [[75,90,10,10],[122,90,10,10],[94,64,9,8]]) {rect(ctx,wx,wy,ww,wh,'#f1ca7b');rect(ctx,wx+4,wy,1,wh,'#b9935c');rect(ctx,wx,wy+4,ww,1,'#b9935c');}
      if (season==='night') {
        for(let i=0;i<7;i++){const fx=40+(i*47)%299+Math.sin(seconds*.4+i)*4,fy=135+(i*23)%84;ctx.globalAlpha=.35+Math.sin(seconds*1.3+i)*.3;rect(ctx,fx,fy,2,2,'#f2e79e');}ctx.globalAlpha=1;
      }
    }
    // A small marker provides direct feedback for hover without covering the art.
    if(hover){const region=hover==='chat'?{x:x-13,y:y-28,w:26}:HOTSPOTS.find(r=>r.id===hover);if(region){const cx=Math.round(region.x+region.w/2);rect(ctx,cx-3,region.y-5,6,2,'#fbefc5');rect(ctx,cx-1,region.y-3,2,2,'#fbefc5');}}
  }
  function loop(timestamp) {
    frame=null;if(destroyed||document.hidden)return;
    if(timestamp-lastPaint>=66||!lastPaint){paint(Date.now()+clockOffset);lastPaint=timestamp;}
    if(!motion.matches)frame=requestAnimationFrame(loop);
  }
  function start() { if(destroyed||document.hidden)return; if(frame===null)frame=requestAnimationFrame(loop); }
  function pointer(event) {const box=canvas.getBoundingClientRect();return {x:(event.clientX-box.left)/box.width*W,y:(event.clientY-box.top)/box.height*H};}
  function hit(event) {const p=pointer(event);if(pet&&Math.abs(p.x-position.x)<16&&p.y>position.y-28&&p.y<position.y+7)return 'chat';return HOTSPOTS.find(r=>p.x>=r.x&&p.x<=r.x+r.w&&p.y>=r.y&&p.y<=r.y+r.h)?.id||null;}
  function move(event) {const next=hit(event);if(next!==hover){hover=next;canvas.style.cursor=next?'pointer':'default';if(motion.matches)paint(Date.now()+clockOffset);}}
  function leave(){hover=null;canvas.style.cursor='default';if(motion.matches)paint(Date.now()+clockOffset);}
  function click(event){const action=hit(event);if(action)onInteract(action);}
  function visibility(){if(document.hidden){if(frame!==null)cancelAnimationFrame(frame);frame=null;}else{lastPaint=0;start();}}
  function motionChange(){if(frame!==null)cancelAnimationFrame(frame);frame=null;lastPaint=0;start();}
  canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerleave',leave);canvas.addEventListener('click',click);
  document.addEventListener('visibilitychange',visibility);motion.addEventListener('change',motionChange);
  paint(Date.now());start();
  return {
    update(next={}) {
      if(destroyed)return;
      pet=next.pet??null;life=next.life??null;if(Number.isFinite(next.now))clockOffset=next.now-Date.now();
      const appearance=pet?.appearance?.pixels;
      pixels=Array.isArray(appearance)&&appearance.length===256?appearance:defaultAppearance(pet?.species).pixels;
      const original=defaultAppearance('xiaotangyuan').pixels;
      defaultFace=(!pet?.species||pet.species==='xiaotangyuan')&&pixels.every((color,i)=>color===original[i]);
      paint(Date.now()+clockOffset);start();
    },
    destroy(){destroyed=true;if(frame!==null)cancelAnimationFrame(frame);frame=null;canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerleave',leave);canvas.removeEventListener('click',click);document.removeEventListener('visibilitychange',visibility);motion.removeEventListener('change',motionChange);},
  };
}
