import { compileProject } from "../src/agent-project/compiler.js";
import { validateFiles } from "../src/agent-project/files.js";
export default async function compile(input: unknown) {
  return compileProject(validateFiles(input));
}
