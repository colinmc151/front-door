// Build the portal: compile the JSX in src/portal.src.html to plain JS
// (public/app.js), emit public/index.html without in-browser Babel, and
// copy the React UMD bundles to public/vendor/ so nothing loads from a CDN.
//
// Usage: npm run build
const fs = require("fs");
const path = require("path");
const Babel = require("@babel/standalone");

const root = path.join(__dirname, "..");
const srcFile = path.join(root, "src", "portal.src.html");
const publicDir = path.join(root, "public");
const vendorDir = path.join(publicDir, "vendor");

// 1. Extract and compile the JSX
const src = fs.readFileSync(srcFile, "utf8");
const match = src.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!match) {
  console.error("No <script type=\"text/babel\"> block found in", srcFile);
  process.exit(1);
}
const compiled = Babel.transform(match[1], {
  presets: [["react", { runtime: "classic" }]],
}).code;
fs.writeFileSync(path.join(publicDir, "app.js"), compiled);

// 2. Emit index.html with the compiled script referenced externally
const html = src.replace(
  /<script type="text\/babel">[\s\S]*?<\/script>/,
  '<script defer src="/app.js"></script>'
);
fs.writeFileSync(path.join(publicDir, "index.html"), html);

// 3. Copy React UMD bundles
fs.mkdirSync(vendorDir, { recursive: true });
for (const [pkg, file] of [
  ["react", "react.production.min.js"],
  ["react-dom", "react-dom.production.min.js"],
]) {
  fs.copyFileSync(
    path.join(root, "node_modules", pkg, "umd", file),
    path.join(vendorDir, file)
  );
}

console.log("Built public/index.html, public/app.js, public/vendor/ from src/portal.src.html");
