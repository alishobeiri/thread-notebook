from setuptools import setup, find_packages
import os

# Determine the directory containing setup.py and get its parent directory
this_directory = os.path.abspath(os.path.dirname(__file__))
parent_directory = os.path.abspath(os.path.join(this_directory, os.pardir))

# Read the content of README.md from the parent directory
with open(os.path.join(parent_directory, "README.md"), "r") as fh:
    long_description = fh.read()

# Replace all mentions of 'public/' with 'thread-notebook/static/'
long_description = long_description.replace(
    'public/', 'thread_notebook/static/')

setup(
    name="thread-notebook",
    version="0.1.36",
    packages=find_packages(),
    include_package_data=True,
    package_data={"thread_notebook": ["static/**/*"]},
    install_requires=[
        "jupyter-server>=2.0",
        "jupyter",
        # Powers the /lsp/ws/<server> WebSocket endpoints the front-end connects
        # to for completions, hover, and diagnostics. Without jupyter-lsp the
        # endpoints do not exist. basedpyright is the primary language server
        # (type inference + sharp completions); python-lsp-server is kept as a
        # lightweight fallback.
        "jupyter-lsp>=2.0",
        "basedpyright>=1.13",
        "python-lsp-server>=1.7",
    ],
    entry_points={
        "console_scripts": [
            "thread-notebook = thread_notebook:launch_instance",
            "thread = thread_notebook:launch_instance",
        ],
        "jupyter_server_extension_points": [
            "thread-notebook = thread_notebook:ThreadNotebookApp",
        ],
    },
    long_description=long_description,
    long_description_content_type="text/markdown",
)
