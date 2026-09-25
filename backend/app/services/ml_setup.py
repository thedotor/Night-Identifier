from app.config import settings


def configure_ultralytics() -> None:
    """Ultralytics defaults to writing pretrained weights/run outputs relative
    to the current working directory (or a fixed path under Documents), which
    would scatter files outside our managed data folder. Redirect all of it
    under settings.data_dir before the library is used anywhere.
    """
    from ultralytics import settings as ultra_settings

    ml_dir = settings.data_dir / "ml_cache"
    ultra_settings.update(
        {
            "weights_dir": str(ml_dir / "weights"),
            "runs_dir": str(ml_dir / "runs"),
            "datasets_dir": str(ml_dir / "datasets"),
            "sync": False,
        }
    )
