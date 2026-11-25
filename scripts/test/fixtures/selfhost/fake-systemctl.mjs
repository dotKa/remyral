#!/usr/bin/env node
// A fake `systemctl` for scripts/test/selfhost-ctl.test.mjs (p17-domain-wizard): records every invocation in
// $FAKE_DOCKER_LOG with a `systemctl` prefix; units are only the files remyral-ctl writes into REMYRAL_CTL_SYSTEMD_DIR.
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.FAKE_DOCKER_LOG, `systemctl ${process.argv.slice(2).join(' ')}\n`);
process.exit(0);
