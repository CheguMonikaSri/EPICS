import pandas as pd
import joblib
import os
from sklearn.model_selection import train_test_split
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline
from sklearn.metrics import accuracy_score, classification_report

print("--- Starting Model Training ---")

# --- 1. Define File Paths ---
script_dir = os.path.dirname(os.path.abspath(__file__))
dataset_path = os.path.join(script_dir, 'dataset.csv')
model_path = os.path.join(script_dir, 'letter_classifier.joblib')

# --- 2. Load Your Labeled Dataset ---
try:
    data = pd.read_csv(dataset_path)
    data['text'] = data['text'].fillna('') # Handle any missing text
    print(f"Loaded {len(data)} labeled examples from dataset.csv")
except FileNotFoundError:
    print(f"Error: 'dataset.csv' not found at {dataset_path}")
    print("Please run 'preprocess.py' first to create this file.")
    exit()

if len(data) < 10:
    print(f"Warning: You only have {len(data)} examples. The model may not be accurate.")
    print("For best results, add more letters to 'training_letters' and re-run 'preprocess.py'.")

X = data['text']
y = data['label']

# --- 3. Split Data for Training and Testing ---
# We'll use 80% for training and 20% for testing its accuracy
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

print(f"Training with {len(X_train)} examples, testing with {len(X_test)} examples.")

# --- 4. Create a Scikit-learn Pipeline ---
# This pipeline does two things automatically:
# 1. 'vectorizer': Converts raw text into word counts (using CountVectorizer)
# 2. 'classifier': Trains the Naive Bayes model on those counts
model_pipeline = Pipeline([
    ('vectorizer', CountVectorizer(stop_words='english')),
    ('classifier', MultinomialNB())
])

# --- 5. Train the Model ---
print("Training the Multinomial Naive Bayes model...")
model_pipeline.fit(X_train, y_train)

# --- 6. Test Model Accuracy (Optional but Recommended) ---
print("\nModel training complete. Testing accuracy...")
y_pred = model_pipeline.predict(X_test)
accuracy = accuracy_score(y_test, y_pred)
print(f"   Accuracy on Test Data: {accuracy * 100:.2f}%")
print("\nClassification Report:")
print(classification_report(y_test, y_pred))


# --- 7. Save the Final Trained Model ---
# This saves the entire pipeline (vectorizer + model) into one file
joblib.dump(model_pipeline, model_path)

print(f"\n--- Success! ---")
print(f"Model saved successfully to: {model_path}")
print("You can now run 'mas_workflow.py'.")