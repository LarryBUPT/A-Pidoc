import requests
def health():
    return requests.get("https://api.example.test/health")
