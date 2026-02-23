#!/usr/bin/env python3
"""List and sell all MM positions on Polymarket via CLOB API"""
import json, sys, os, time, hmac, hashlib, base64

STATE_FILE = "/root/.openclaw/polymarket-mm.json"

def load_state():
    with open(STATE_FILE) as f:
        return json.load(f)

def list_positions():
    data = load_state()
    pos = data.get("positions", {})
    total_value = 0
    print("Balance: $%.2f" % data['capital'])
    print("Positions: %d" % len(pos))
    print("-" * 80)
    for tid, p in pos.items():
        val = p["netShares"] * p["avgEntry"]
        total_value += val
        print("  %3s | shares=%10s | entry=$%.4f | ~$%.2f | %s" % (
            p['outcome'], p['netShares'], p['avgEntry'], val, p['conditionId'][:18]))
    print("-" * 80)
    print("Total invested: ~$%.2f" % total_value)
    return data

if __name__ == "__main__":
    list_positions()
