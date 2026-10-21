#!/usr/bin/env node
// Fake AI CLI: reads --output-last-message path and writes one reviewed proposal.
import fs from 'node:fs';
const i=process.argv.indexOf('--output-last-message');
if(i<0)process.exit(3);
const record={confidence:0.96,skip:false,scene:'shade',
  reason:'Test fixture: slightly underexposed subject',changes:{Exposure2012:0.30}};
fs.writeFileSync(process.argv[i+1],JSON.stringify(record));
process.stdout.write('Mock image analysis complete\n');
