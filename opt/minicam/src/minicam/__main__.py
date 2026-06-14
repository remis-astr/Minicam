import logging
import uvicorn
from minicam.api.app import create_app
from minicam.config import load_config

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","name":"%(name)s","msg":"%(message)s"}',
)

cfg = load_config()
app = create_app()

if __name__ == "__main__":
    uvicorn.run(app, host=cfg["api"]["host"], port=cfg["api"]["port"], log_config=None)
