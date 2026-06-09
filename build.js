// بناء التطبيق: يترجم src/app.jsx (JSX) إلى app.js (جافاسكريبت عادي مُصغّر)
// بدون الحاجة لـ Babel في المتصفح — وده اللي بيخلي التحميل أسرع بكتير.
//
// التعديلات تتم على src/app.jsx ثم: npm run build:app
// النتيجة app.js تُرفع كما هي (Vercel يخدمها ثابتة بدون خطوة بناء).
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const { minify } = require('terser');

const SRC = path.join(__dirname, 'src', 'app.jsx');
const OUT = path.join(__dirname, 'app.js');

const jsx = fs.readFileSync(SRC, 'utf8');
const compiled = babel.transformSync(jsx, {
  presets: [['@babel/preset-react', { runtime: 'classic' }]],
  comments: false,
}).code;

minify(compiled, {
  ecma: 2020,
  compress: { passes: 2 },
  mangle: true,
  format: { comments: false },
}).then((min) => {
  if (min.error) throw min.error;
  new Function(min.code); // فحص بسيط للصياغة
  fs.writeFileSync(OUT, min.code);
  console.log('✅ Built app.js:', min.code.length, 'chars');
});
