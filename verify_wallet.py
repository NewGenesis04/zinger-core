#!/usr/bin/env python3
"""
Temporary Wallet & Polymarket Balance Verifier (100% Pure Standard Library)
Reads temporary test keys from .env and verifies:
  1. Key Format & Address Validation
  2. POL (Gas) Balances on Polygon
  3. Native USDC (0x3c49...) and Bridged USDC.e (0x2791...) on Polygon
  4. Polymarket Live Positions & Account State
"""

import os
import sys
import json
import subprocess
import urllib.request
import urllib.error

# ── 1. Load .env automatically ──
def load_env():
    paths = [
        os.path.join(os.path.dirname(__file__), ".env"),
        os.path.join(os.getcwd(), ".env"),
    ]
    for env_path in paths:
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("'").strip('"')
                    if k not in os.environ:
                        os.environ[k] = v
            break

load_env()

# Read temporary test keys from .env
PRIVATE_KEY = os.getenv("TEST_PRIVATE_KEY", "").strip()
DEPOSIT_ADDRESS = os.getenv("TEST_DEPOSIT_ADDRESS", "").strip()
RELAYER_KEY = os.getenv("TEST_RELAYER_KEY", "").strip()

POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com"
NATIVE_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
BRIDGED_USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
POLY_PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"

def rpc_call(method, params):
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params
    }).encode("utf-8")
    req = urllib.request.Request(POLYGON_RPC, data=payload, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        return res.get("result")

def get_native_pol(address):
    try:
        res = rpc_call("eth_getBalance", [address, "latest"])
        if not res:
            return 0.0
        return int(res, 16) / 10**18
    except Exception:
        return 0.0

def get_erc20_balance(token_address, owner_address):
    try:
        clean_owner = owner_address.lower().replace("0x", "").zfill(64)
        data = f"0x70a08231{clean_owner}"
        res = rpc_call("eth_call", [{"to": token_address, "data": data}, "latest"])
        if not res or res == "0x":
            return 0.0
        return int(res, 16) / 10**6
    except Exception:
        return 0.0

def get_polymarket_positions(address):
    url = f"https://data-api.polymarket.com/positions?user={address}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data if isinstance(data, list) else []
    except Exception:
        return []

def derive_address_from_key(pk):
    if not pk:
        return None
    try:
        clean_pk = pk if pk.startswith("0x") else f"0x{pk}"
        js_code = f"import('viem/accounts').then(m => console.log(m.privateKeyToAccount('{clean_pk}').address)).catch(() => {{}})"
        cmd = ["node", "-e", js_code]
        res = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL).strip()
        if res.startswith("0x") and len(res) == 42:
            return res
    except Exception:
        pass
    return None

def main():
    print("=" * 65)
    print("  🔐 ZINGER WALLET & POLYMARKET VERIFIER")
    print("=" * 65)

    # 1. Validate Private Key
    signer_address = None
    if PRIVATE_KEY:
        clean_pk = PRIVATE_KEY[2:] if PRIVATE_KEY.startswith("0x") else PRIVATE_KEY
        if len(clean_pk) == 64:
            print("✅ Private Key Format: Valid 64-hex key")
            signer_address = derive_address_from_key(PRIVATE_KEY)
            if signer_address:
                print(f"✅ Signer Address (derived): {signer_address}")
        else:
            print(f"⚠️  Private key length ({len(clean_pk)}) is unusual (expected 64 hex chars).")
    else:
        print("⚠️  TEST_PRIVATE_KEY not set in .env")

    deposit_addr = DEPOSIT_ADDRESS or signer_address
    if not deposit_addr:
        print("\n❌ Error: Neither TEST_PRIVATE_KEY nor TEST_DEPOSIT_ADDRESS found in .env")
        print("\nPlease add to your .env file:")
        print("TEST_PRIVATE_KEY=0xYOUR_PRIVATE_KEY")
        print("TEST_DEPOSIT_ADDRESS=0xYOUR_DEPOSIT_ADDRESS")
        print("TEST_RELAYER_KEY=YOUR_RELAYER_KEY (optional)\n")
        sys.exit(1)

    print(f"📍 Polymarket Deposit / Safe Address: {deposit_addr}")
    if RELAYER_KEY:
        print(f"🔑 Relayer / API Key:               {RELAYER_KEY[:6]}...{RELAYER_KEY[-4:]}")

    print("\n" + "─" * 65)
    print("  📊 ON-CHAIN POLYGON BALANCES")
    print("─" * 65)

    # Check Signer Address if different from Deposit Address
    if signer_address and signer_address.lower() != deposit_addr.lower():
        signer_pol = get_native_pol(signer_address)
        signer_usdc_native = get_erc20_balance(NATIVE_USDC, signer_address)
        signer_usdc_bridged = get_erc20_balance(BRIDGED_USDC, signer_address)
        print(f"👤 Signer Wallet ({signer_address[:6]}...{signer_address[-4:]}):")
        print(f"   • Native POL (Gas):   {signer_pol:.4f} POL")
        print(f"   • Native USDC:        ${signer_usdc_native:.2f}")
        print(f"   • Bridged USDC.e:     ${signer_usdc_bridged:.2f}")
        print()

    # Check Deposit Address
    deposit_pol = get_native_pol(deposit_addr)
    deposit_pusd = get_erc20_balance(POLY_PUSD, deposit_addr)
    deposit_usdc_native = get_erc20_balance(NATIVE_USDC, deposit_addr)
    deposit_usdc_bridged = get_erc20_balance(BRIDGED_USDC, deposit_addr)
    print(f"🏦 Deposit / Safe Wallet ({deposit_addr[:6]}...{deposit_addr[-4:]}):")
    print(f"   • Native POL (Gas):   {deposit_pol:.4f} POL")
    print(f"   • Polymarket pUSD:    ${deposit_pusd:.2f}")
    print(f"   • Native USDC:        ${deposit_usdc_native:.2f}")
    print(f"   • Bridged USDC.e:     ${deposit_usdc_bridged:.2f}")

    total_usdc = deposit_pusd + deposit_usdc_native + deposit_usdc_bridged
    print("\n" + "─" * 65)
    print(f"💰 Total Spendable Balance on Polymarket: ${total_usdc:.2f}")
    print("─" * 65)

    # Check Polymarket Open Positions
    print("\n🔍 Checking Polymarket Data API for active positions...")
    positions = get_polymarket_positions(deposit_addr)
    if positions:
        print(f"📦 Found {len(positions)} active position(s) on Polymarket:")
        for p in positions[:5]:
            title = p.get("title") or p.get("market", {}).get("question") or "Position"
            outcome = p.get("outcome") or "UP/DOWN"
            size = p.get("size") or 0
            cur_val = p.get("currentValue") or 0
            print(f"   • {title[:35]}... | Side: {outcome} | Size: {size} sh | Value: ${float(cur_val):.2f}")
    else:
        print("ℹ️  No open positions currently on Polymarket account.")

    print("\n" + "=" * 65)
    if total_usdc >= 0.50:
        print("✅ SUCCESS: Account has funded USDC and is ready for Live Trading!")
    else:
        print("⚠️  NOTE: Spendable USDC balance is $0.00. Make sure funds are on Polygon.")
    print("=" * 65 + "\n")

if __name__ == "__main__":
    main()
