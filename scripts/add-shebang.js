/*
 * Copyright (c) 2026 Sidney Anderson
 * All Rights Reserved — Proprietary Software
 *
 * This software is confidential and provided for authorized internal use only.
 * Redistribution, modification, reverse-engineering, AI-training use,
 * commercial deployment, or disclosure to third parties is prohibited
 * without prior written permission.
 *
 * See LICENSE and NOTICE.txt for full terms.
 */
import fs from "fs";
const file = "build/index.js";

const contents = fs.readFileSync(file, "utf8");
if (!contents.startsWith("#!/usr/bin/env node")) {
  fs.writeFileSync(file, "#!/usr/bin/env node\n" + contents);
}

