import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildImage,
  dockerExec,
  startContainer,
  stopContainer,
} from "./helpers";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

beforeAll(() => {
  buildImage(ROOT);
  startContainer();
}, 300_000);

afterAll(() => {
  stopContainer();
});

describe("Babysitter SDK CLI", () => {
  test("babysitter health --json returns valid JSON", () => {
    const out = dockerExec("babysitter health --json").trim();
    const json = JSON.parse(out);
    expect(json).toBeDefined();
  });

  test("session:init and session:state roundtrip", () => {
    const stateDir = "/tmp/sdk-test-state";

    const out = dockerExec(
      [
        `mkdir -p ${stateDir}`,
        `babysitter session:init --session-id sdk-rt --state-dir ${stateDir} --prompt "roundtrip test" --json`,
        `babysitter session:state --session-id sdk-rt --state-dir ${stateDir} --json`,
        `rm -rf ${stateDir}`,
      ].join(" && "),
    ).trim();

    // session:state is the last line of output
    const lines = out.split("\n").filter((l) => l.trim());
    const stateJson = JSON.parse(lines[lines.length - 1]);
    expect(stateJson.found).toBe(true);
    expect(stateJson.state.active).toBe(true);
    expect(stateJson.prompt).toBe("roundtrip test");
  });

  test("session:update increments iteration", () => {
    const stateDir = "/tmp/sdk-test-iter";

    const out = dockerExec(
      [
        `mkdir -p ${stateDir}`,
        `babysitter session:init --session-id iter-t --state-dir ${stateDir} --prompt "test" --json`,
        `babysitter session:update --session-id iter-t --state-dir ${stateDir} --iteration 5 --json`,
        `babysitter session:state --session-id iter-t --state-dir ${stateDir} --json`,
        `rm -rf ${stateDir}`,
      ].join(" && "),
    ).trim();

    const lines = out.split("\n").filter((l) => l.trim());
    const stateJson = JSON.parse(lines[lines.length - 1]);
    expect(stateJson.state.iteration).toBe(5);
  });

  test("session:update --delete removes session", () => {
    const stateDir = "/tmp/sdk-test-del";

    const out = dockerExec(
      [
        `mkdir -p ${stateDir}`,
        `babysitter session:init --session-id del-t --state-dir ${stateDir} --prompt "test" --json`,
        `babysitter session:update --session-id del-t --state-dir ${stateDir} --delete --json`,
        `babysitter session:state --session-id del-t --state-dir ${stateDir} --json`,
        `rm -rf ${stateDir}`,
      ].join(" && "),
    ).trim();

    const lines = out.split("\n").filter((l) => l.trim());
    const stateJson = JSON.parse(lines[lines.length - 1]);
    expect(stateJson.found).toBe(false);
  });
});
