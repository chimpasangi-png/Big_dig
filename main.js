import os
import time
import random
import requests
from datetime import datetime, timezone

# ================= CONFIGURATION =================

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "@TROONCHAIN")

TARGET_AMOUNTS = {300.0, 1000.0, 3200.0, 5000.0}

MIN_COOLDOWN_SEC = 351
MAX_COOLDOWN_SEC = 18000
MAX_BLOCK_AGE_SEC = 180
POLL_INTERVAL = 3

FULLNODE_URL = "https://api.trongrid.io/wallet/getnowblock"
USDT_HEX_CONTRACT = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c"
TRANSFER_METHOD_ID = "a9059cbb"
DECIMALS = 10**6

# Reuse connections
session = requests.Session()


def send_telegram_proof(amount, tx_id, block_num, block_time_str):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    tronscan_link = f"https://tronscan.org/#/transaction/{tx_id}"

    tier_names = {
        300.0: "Demo Allocation (300 USDT)",
        1000.0: "Starter Allocation (1,000 USDT)",
        3200.0: "Standerd Allocation (3,200 USDT)",
        5000.0: "Pro Allocation (5,000 USDT)",
    }
    tier_name = tier_names.get(amount, f"{amount:g} USDT")

    text = (
        f"⚡ *DISPATCH CONFIRMED (TRC-20)*\n\n"
        f"📦 *Tier:* `{tier_name}`\n"
        f"⏱️ *Detected:* `{block_time_str}` (Block #{block_num})\n"
        f"🌐 *Network:* `Tron (TRC-20)`\n"
        f"🔎 *Status:* `Transfer call detected; execution not independently verified`\n\n"
        f"🔗 [View transaction on Tronscan]({tronscan_link})\n\n"
        f"👉 *Next batch:* @Quickflashbot"
    )

    try:
        response = session.post(
            url,
            json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": text,
                "parse_mode": "Markdown",
                "disable_web_page_preview": True,
            },
            timeout=15,
        )

        try:
            result = response.json()
        except ValueError:
            result = {"description": response.text}

        if response.ok and result.get("ok") is True:
            print(f"✅ Telegram accepted post for {amount:g} USDT")
            return True

        print(
            f"❌ Telegram rejected post: HTTP {response.status_code} "
            f"| {result}"
        )
        return False

    except requests.RequestException as exc:
        print(f"❌ Telegram request failed: {exc}")
        return False


def main():
    seen_txids = set()
    last_block_num = 0
    next_allowed_post_time = 0

    print("🚀 Tron USDT monitor started")
    print(f"📡 Target amounts: {sorted(TARGET_AMOUNTS)} USDT")
    print(f"📢 Telegram destination: {TELEGRAM_CHAT_ID}")

    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is empty")

    while True:
        try:
            response = session.post(FULLNODE_URL, json={}, timeout=15)
            response.raise_for_status()
            block_data = response.json()

            header = block_data.get("block_header", {}).get("raw_data", {})
            block_num = header.get("number", 0)
            block_ts = header.get("timestamp", 0)

            if not block_num or not block_ts:
                print("⚠️ Tron API returned incomplete block data")
                time.sleep(POLL_INTERVAL)
                continue

            age_seconds = time.time() - block_ts / 1000

            if age_seconds < -30 or age_seconds > MAX_BLOCK_AGE_SEC:
                print(f"⚠️ Block #{block_num} timestamp outside allowed age")
                time.sleep(POLL_INTERVAL)
                continue

            if block_num != last_block_num:
                last_block_num = block_num
                transactions = block_data.get("transactions", [])

                for tx in transactions:
                    tx_id = tx.get("txID")
                    if not tx_id or tx_id in seen_txids:
                        continue

                    seen_txids.add(tx_id)

                    for contract in tx.get("raw_data", {}).get("contract", []):
                        if contract.get("type") != "TriggerSmartContract":
                            continue

                        value = (
                            contract.get("parameter", {})
                            .get("value", {})
                        )

                        if value.get("contract_address", "").lower() != USDT_HEX_CONTRACT:
                            continue

                        data = value.get("data", "")

                        if not data.startswith(TRANSFER_METHOD_ID) or len(data) < 136:
                            continue

                        try:
                            raw_amount = int(data[-64:], 16)
                            amount = round(raw_amount / DECIMALS, 6)
                        except (ValueError, TypeError):
                            continue

                        if amount not in TARGET_AMOUNTS:
                            continue

                        block_time = datetime.fromtimestamp(
                            block_ts / 1000, tz=timezone.utc
                        ).strftime("%Y-%m-%d %H:%M:%S UTC")

                        print(
                            f"🔎 Match: {amount:g} USDT | "
                            f"TXID: {tx_id} | Block #{block_num}"
                        )

                        now = time.time()

                        if now < next_allowed_post_time:
                            remaining = int(next_allowed_post_time - now)
                            print(f"⏳ Cooldown active: {remaining}s remaining")
                            continue

                        posted = send_telegram_proof(
                            amount, tx_id, block_num, block_time
                        )

                        if posted:
                            wait_gap = random.randint(
                                MIN_COOLDOWN_SEC, MAX_COOLDOWN_SEC
                            )
                            next_allowed_post_time = time.time() + wait_gap
                            print(
                                f"⏱️ Next post allowed in "
                                f"{wait_gap / 60:.1f} minutes"
                            )

            if len(seen_txids) > 20000:
                seen_txids.clear()

        except requests.RequestException as exc:
            print(f"⚠️ Tron API request failed: {exc}")
        except (ValueError, KeyError) as exc:
            print(f"⚠️ Invalid API response: {exc}")
        except Exception as exc:
            print(f"⚠️ Unexpected error: {type(exc).__name__}: {exc}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
