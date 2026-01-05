import fs from "fs";
const file = "build/index.js";

const contents = fs.readFileSync(file, "utf8");
if (!contents.startsWith("#!/usr/bin/env node")) {
  fs.writeFileSync(file, "#!/usr/bin/env node\n" + contents);
}
