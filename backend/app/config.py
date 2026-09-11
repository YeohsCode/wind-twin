from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = f"sqlite:///{Path(__file__).parents[1] / 'data' / 'wind_twin.db'}"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""
    llm_timeout_seconds: int = 20

    class Config:
        env_file = ".env"

    @property
    def origin_list(self) -> list[str]:
        return [x.strip() for x in self.cors_origins.split(",") if x.strip()]

    @property
    def llm_ready(self) -> bool:
        return bool(self.llm_base_url and self.llm_api_key and self.llm_model)


@lru_cache
def get_settings() -> Settings:
    return Settings()
