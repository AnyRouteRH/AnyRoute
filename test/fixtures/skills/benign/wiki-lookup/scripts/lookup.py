import sys
import requests

params = {"action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1, "format": "json", "titles": sys.argv[1]}
response = requests.get("https://en.wikipedia.org/w/api.php", params=params, timeout=10)
for page in response.json()["query"]["pages"].values():
    print(page.get("title"), "-", (page.get("extract") or "")[:600])
