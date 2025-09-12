import fs from "node:fs";
import crypto from "node:crypto";

export function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const output = crypto.createHash("md5");
    const input = fs.createReadStream(path);

    input.on("error", err => {
      reject(err);
    });

    output.once("readable", () => {
      resolve(output.read().toString("hex"));
    });

    input.pipe(output);
  });
}
