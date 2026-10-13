import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(projectRoot, "www");
const files = [
    ["index.html", "index.html"],
    ["manifest.json", "manifest.json"],
    ["service-worker.js", "service-worker.js"],
    ["Logo.png", "Logo.png"],
    ["css", "css"],
    ["icons", "icons"],
    ["js/app.js", "js/app.js"],
    ["js/mobile-store.js", "js/mobile-store.js"],
    ["js/pwa.js", "js/pwa.js"]
];

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "js"), { recursive: true });
for (const [source, destination] of files) {
    await cp(
        path.join(projectRoot, source),
        path.join(output, destination),
        { recursive: true }
    );
}
const indexPath = path.join(output, "index.html");
const index = await readFile(indexPath, "utf8");
if (!index.includes('name="app-mode"')) {
    await writeFile(
        indexPath,
        index.replace("</head>", '    <meta name="app-mode" content="native">\n</head>'),
        "utf8"
    );
}
const chartBundle = path.join(projectRoot, "node_modules", "chart.js", "dist", "chart.umd.min.js");
const localChartBundle = path.join(projectRoot, "js", "chart.umd.min.js");
await cp(chartBundle, localChartBundle);
await cp(
    localChartBundle,
    path.join(output, "js", "chart.umd.min.js")
);
