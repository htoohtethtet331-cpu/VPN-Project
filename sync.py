import time
import requests
# pyrefly: ignore [missing-import]
import urllib3
import json
import logging
from datetime import datetime

# --- [ CONFIGURATION ] ---
NODE_API_URL = "http://localhost:3000/api"

# --- [ LOGGING SETUP ] ---
# sync.log ဖိုင်ထဲသို့ မှတ်တမ်းများ အလိုအလျောက် ရေးသွင်းမည်
logging.basicConfig(
    filename='sync.log',
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# ထပ်ဆောင်း Console ပေါ်တွင်ပါ ပြသရန် (Terminal တွင် မြင်ရရန်)
console = logging.StreamHandler()
console.setLevel(logging.INFO)
formatter = logging.Formatter('%(asctime)s | %(levelname)s | %(message)s', datefmt='%H:%M:%S')
console.setFormatter(formatter)
logging.getLogger('').addHandler(console)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def sync_data():
    logging.info("Starting API Sync Cycle...")
    
    try:
        # Step 1: Get Data from Node.js
        db_res = requests.get(f"{NODE_API_URL}/sync-data", timeout=10)
        if db_res.status_code != 200:
            logging.error(f"Failed to connect to Node.js Server. Status Code: {db_res.status_code}")
            return
        db = db_res.json()
    except Exception as e:
        logging.error(f"Node.js Connection Error: {e}")
        return

    configs = db.get("admin_config", {}).get("server_api", {})
    if not configs: 
        logging.warning("Server Configs (Outline/X-UI API URLs) are missing in the Database!")
        return

    outline_url = configs.get("outline_url")
    xui_url, xui_user, xui_pass = configs.get("xui_url"), configs.get("xui_user"), configs.get("xui_pass")
    today = datetime.now().date()

    # Step 2: Fetch External VPN APIs (Outline)
    outline_keys_map = {}
    outline_usage = {}
    if outline_url:
        try:
            res_usage = requests.get(f"{outline_url}/metrics/transfer", verify=False, timeout=10)
            outline_usage = res_usage.json().get('bytesTransferredByUserId', {})
            res_keys = requests.get(f"{outline_url}/access-keys", verify=False, timeout=10)
            for k in res_keys.json().get('accessKeys', []):
                outline_keys_map[k['accessUrl']] = k
            logging.info("Successfully fetched data from Outline API.")
        except Exception as e:
            logging.warning(f"Outline API unreachable or returned an error: {e}")

    # Step 3: Fetch External VPN APIs (X-UI)
    xui_clients_map = {}
    xui_session = requests.Session()
    if xui_url and xui_user:
        try:
            xui_session.post(f"{xui_url}/login", data={'username': xui_user, 'password': xui_pass}, timeout=10)
            res_inb = xui_session.get(f"{xui_url}/panel/api/inbounds", timeout=10)
            for inbound in res_inb.json().get('obj', []):
                inb_id = inbound['id']
                settings = json.loads(inbound.get('settings', '{}'))
                for c in settings.get('clients', []):
                    xui_clients_map[c['email']] = (inb_id, c)
            logging.info("Successfully fetched data from X-UI (VLESS) API.")
        except Exception as e:
            logging.warning(f"X-UI API unreachable or returned an error: {e}")

    users = db.get("users", {})
    update_fields = {}
    suspended_count = 0

    # Step 4: Logic Processing
    for user_id, user_data in users.items():
        user_updates = {}
        
        # --- Outline Logic ---
        out_key_url = user_data.get('outlineKey', '')
        if out_key_url in outline_keys_map:
            out_client = outline_keys_map[out_key_url]
            used_bytes = outline_usage.get(out_client['id'], 0)
            user_updates['outlineUsedGB'] = round(used_bytes / (1024**3), 3)

            target_limit_gb = float(user_data.get('outlineTotalGB', 0))
            target_limit_bytes = int(target_limit_gb * (1024**3))
            
            # Auto Suspend Logic
            is_expired = False
            if user_data.get('outlineExpireDate'):
                try:
                    if today > datetime.strptime(user_data.get('outlineExpireDate'), "%Y-%m-%d").date():
                        is_expired = True
                except: pass

            current_limit = out_client.get('dataLimit', {}).get('bytes')
            if (is_expired or (target_limit_gb > 0 and used_bytes >= target_limit_bytes)):
                if current_limit != 0:
                    requests.put(f"{outline_url}/access-keys/{out_client['id']}/data-limit", json={"limit": {"bytes": 0}}, verify=False)
                    logging.info(f"ACTION: Suspended Outline Access for User [{user_id}] (Limit Reached or Expired).")
                    suspended_count += 1
            else:
                # Sync limits if changed in admin
                if target_limit_gb > 0 and current_limit != target_limit_bytes:
                    requests.put(f"{outline_url}/access-keys/{out_client['id']}/data-limit", json={"limit": {"bytes": target_limit_bytes}}, verify=False)
                    logging.info(f"Updated Outline Limit for User [{user_id}] to {target_limit_gb}GB.")

        # --- VLESS Logic ---
        if user_id in xui_clients_map:
            inb_id, c_dict = xui_clients_map[user_id]
            try:
                res_stats = xui_session.get(f"{xui_url}/panel/api/inbounds/getClientTraffics/{c_dict['email']}")
                stats = res_stats.json().get('obj', {})
                vless_used = (stats.get('up', 0) + stats.get('down', 0)) / (1024**3)
                user_updates['vlessUsedGB'] = round(vless_used, 3)
            except Exception as e: 
                logging.warning(f"Failed to fetch VLESS stats for User [{user_id}]: {e}")

        if user_updates:
            update_fields[user_id] = user_updates
 
    # Step 5: Send Back to Node.js
    if update_fields:
        try:
            requests.post(f"{NODE_API_URL}/sync-update", json={"update_fields": update_fields}, timeout=10)
            logging.info(f"Sync Complete: Updated {len(update_fields)} users. (Suspended: {suspended_count})")
        except Exception as e:
            logging.error(f"Failed to push updates back to Node.js Server: {e}")
    else:
        logging.info("Sync Complete: No user updates required.")

if __name__ == "__main__":
    logging.info("=======================================")
    logging.info("🚀 Secure Auto-Sync Engine Started...")
    logging.info("=======================================")
    while True:
        sync_data()
        time.sleep(30) # 30 စက္ကန့်တစ်ခါ စစ်မည်