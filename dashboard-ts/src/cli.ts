#!/usr/bin/env bun
/**
 * Managing the people who can sign in.
 *
 * A dashboard whose only way to add a user is a page you need a user to reach
 * has an obvious hole in it, so this is the way in from the host:
 *
 *   docker compose exec dashboard bun run src/cli.ts users
 *   docker compose exec dashboard bun run src/cli.ts adduser sara
 *   docker compose exec dashboard bun run src/cli.ts passwd sara
 *   docker compose exec dashboard bun run src/cli.ts deluser sara
 *   docker compose exec dashboard bun run src/cli.ts sessions
 *   docker compose exec dashboard bun run src/cli.ts logout-all
 *
 * Passwords are read from the terminal without echo, or from
 * DESKSWARM_NEW_PASSWORD when there is no terminal to prompt at.
 */

import * as auth from "./auth";
import { initDb } from "./schema";
import { all, run } from "./db";

initDb();

const [command, argument] = process.argv.slice(2);

/** Ask without echoing. Falls back to the environment for scripted use. */
async function readPassword(prompt: string): Promise<string> {
  const fromEnv = process.env.DESKSWARM_NEW_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    console.error(
      "no terminal to prompt at — set DESKSWARM_NEW_PASSWORD instead, e.g.\n" +
        "  docker compose exec -e DESKSWARM_NEW_PASSWORD='…' dashboard bun run src/cli.ts passwd sara",
    );
    process.exit(2);
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  let value = "";
  for await (const chunk of process.stdin) {
    for (const byte of chunk as Uint8Array) {
      if (byte === 13 || byte === 10) {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        return value;
      }
      if (byte === 3) {
        process.stdin.setRawMode(false);
        process.exit(130);
      }
      if (byte === 127) value = value.slice(0, -1);
      else value += String.fromCharCode(byte);
    }
  }
  process.stdin.setRawMode(false);
  return value;
}

function usage(): never {
  console.log(
    "usage: bun run src/cli.ts <command>\n\n" +
      "  users                list the people who can sign in\n" +
      "  adduser <name>       add one\n" +
      "  passwd <name>        change a password (ends that user's sessions)\n" +
      "  deluser <name>       remove one (never the last)\n" +
      "  sessions             list live sessions\n" +
      "  logout-all           end every session, everywhere\n",
  );
  process.exit(1);
}

try {
  switch (command) {
    case "users": {
      const rows = auth.listUsers();
      if (!rows.length) console.log("no users yet — the dashboard makes one on first boot");
      for (const u of rows) {
        console.log(
          `${String(u.id).padStart(3)}  ${u.username.padEnd(20)} ` +
            `created ${u.created_at}  last login ${u.last_login_at ?? "never"}`,
        );
      }
      break;
    }

    case "adduser": {
      if (!argument) usage();
      const password = await readPassword(`password for ${argument}: `);
      const user = await auth.createUser(argument, password);
      console.log(`added '${user.username}'`);
      break;
    }

    case "passwd": {
      if (!argument) usage();
      const password = await readPassword(`new password for ${argument}: `);
      await auth.setPassword(argument, password);
      console.log(`changed the password for '${argument}' and signed its sessions out`);
      break;
    }

    case "deluser": {
      if (!argument) usage();
      console.log(auth.deleteUser(argument) ? `removed '${argument}'` : `no such user '${argument}'`);
      break;
    }

    case "sessions": {
      const rows = all<{
        username: string;
        created_at: string;
        expires_at: string;
        last_seen_at: string | null;
        ip: string | null;
      }>(
        "SELECT u.username, s.created_at, s.expires_at, s.last_seen_at, s.ip " +
          "FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC",
      );
      if (!rows.length) console.log("nobody is signed in");
      for (const s of rows) {
        console.log(
          `${s.username.padEnd(20)} from ${(s.ip ?? "?").padEnd(16)} ` +
            `last seen ${s.last_seen_at ?? "—"}  expires ${s.expires_at}`,
        );
      }
      break;
    }

    case "logout-all": {
      const { changes } = run("DELETE FROM sessions");
      console.log(`ended ${changes} session(s)`);
      break;
    }

    default:
      usage();
  }
} catch (err: any) {
  console.error(`error: ${err?.message ?? err}`);
  process.exit(1);
}
